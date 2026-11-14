package dev.lilyco.kuakestudio;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.system.Os;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 小白入口：点桌面图标 -> 进程内起同一套 kuake-studio axum 服务 -> WebView 打开它。
 * 用户完全不需要知道 IP / 端口，也不用装 kuake CLI。
 *
 * 与桌面端共享 build_registry() / server::serve() / 同一份前端 dist，
 * 唯一区别是这里不唤起外部浏览器，而是内嵌 WebView。
 */
public class MainActivity extends Activity {
    private static final String BASE = "http://127.0.0.1:8787";
    private static final int REQ_FILE = 1001;

    /** android/src/lib.rs 导出的 Java_dev_lilyco_kuakestudio_MainActivity_nativeStart */
    private static native void nativeStart();

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            prepare();
        } catch (Throwable t) {
            Toast.makeText(this, "初始化失败: " + t.getMessage(), Toast.LENGTH_LONG).show();
            return;
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 留在 WebView 内，别把 /api/* 请求甩给系统浏览器
        web.setWebViewClient(new WebViewClient());
        // 前端的上传用 <input type=file>，没有 WebChromeClient 点了没反应
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             WebChromeClient.FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = cb;
                try {
                    startActivityForResult(
                            Intent.createChooser(params.createIntent(), "选择文件"), REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });
        setContentView(web);
        waitAndLoad();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || filePathCallback == null) return;
        Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /**
     * Rust 的 paths.rs 读 HOME 找凭据，std::env::temp_dir() 读 TMPDIR，
     * server::default_dist() 读 KUAKE_STUDIO_DIST。都必须先于 loadLibrary 设好，
     * 否则 JNI 里 OnceLock 已经把服务线程拉起来了。
     */
    private void prepare() throws Exception {
        File files = getFilesDir();
        File cache = getCacheDir();
        File dist = new File(files, "dist");
        unpackDist(dist);

        // 下载落到外部私有目录，用户能在「文件」里看到，而不是藏在 cache
        File downloads = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        File temp = downloads != null ? downloads : cache;
        if (!temp.isDirectory()) temp.mkdirs();

        Os.setenv("HOME", files.getAbsolutePath(), true);
        Os.setenv("TMPDIR", temp.getAbsolutePath(), true);
        Os.setenv("KUAKE_STUDIO_DIST", dist.getAbsolutePath(), true);
        Os.setenv("KUAKE_STUDIO_NO_OPEN", "1", true);
        Os.setenv("KUAKE_STUDIO_PORT", "8787", true);
        Os.setenv("KUAKE_STUDIO_BACKEND", "native", true);

        System.loadLibrary("kuake_studio_jni");
        nativeStart();
    }

    /** assets/dist.zip 每次冷启动重解（约 550K），免去升级后的缓存一致性问题。 */
    private void unpackDist(File dist) throws Exception {
        deleteRecursive(dist);
        if (!dist.mkdirs() && !dist.isDirectory()) {
            throw new IllegalStateException("无法创建 dist 目录");
        }
        byte[] buf = new byte[16384];
        try (InputStream in = getAssets().open("dist.zip");
             ZipInputStream zis = new ZipInputStream(in)) {
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                String name = e.getName();
                if (name.startsWith("/") || name.contains("..")) {
                    zis.closeEntry();
                    continue;
                }
                File out = new File(dist, name);
                if (e.isDirectory()) {
                    out.mkdirs();
                } else {
                    File parent = out.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                        throw new IllegalStateException("无法创建目录 " + parent);
                    }
                    try (OutputStream os = new FileOutputStream(out)) {
                        int n;
                        while ((n = zis.read(buf)) > 0) os.write(buf, 0, n);
                    }
                }
                zis.closeEntry();
            }
        }
        if (!new File(dist, "index.html").isFile()) {
            throw new IllegalStateException("assets/dist.zip 缺少 index.html");
        }
    }

    private static void deleteRecursive(File f) {
        if (!f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        f.delete();
    }

    private void waitAndLoad() {
        // 用匿名内部类而非 lambda：纯 javac -bootclasspath android.jar 无 LambdaMetafactory，
        // 避免 invokedynamic 编译失败，也省掉 d8 的 lambda desugar。
        new Thread(new Runnable() {
            @Override public void run() {
                boolean up = false;
                for (int i = 0; i < 80; i++) {
                    if (ping()) { up = true; break; }
                    try { Thread.sleep(250); } catch (InterruptedException ignored) { break; }
                }
                final boolean ok = up;
                web.post(new Runnable() {
                    @Override public void run() {
                        if (ok) {
                            web.loadUrl(BASE + "/");
                        } else {
                            Toast.makeText(MainActivity.this,
                                    "本地服务启动失败，请重启应用", Toast.LENGTH_LONG).show();
                        }
                    }
                });
            }
        }, "kuake-studio-wait").start();
    }

    private static boolean ping() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE + "/api/boot").openConnection();
            c.setConnectTimeout(400);
            c.setReadTimeout(400);
            c.setRequestMethod("GET");
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
