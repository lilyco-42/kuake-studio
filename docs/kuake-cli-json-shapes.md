# kuake CLI JSON 形状快照

由 `tools/dump-kuake-cli-json.mjs --markdown` 生成（只写脱敏后的结构）。
签名直链、fid、stoken、昵称、文件名、路径等敏感字段替换为 `<redacted>` / `<path>`；
倒计时、服务器时间戳等每次都变的字段替换为 `<volatile>`，文档可重复生成且零 diff。
原始快照默认在 `~/.local/share/kuake-studio/kuake-cli-json.json`（权限 600，**不要提交进 git**）。

采集用例：13 个，全是只读命令或缺参错误，不写网盘；失败用例会重试后收录。

| 用例 | argv | exit | 格式 |
|---|---|---:|---|
| `version` | `version` | 0 | json |
| `user` | `user` | 0 | json |
| `list-root` | `list /` | 0 | json |
| `list-subdir` | `list <path>` | 0 | json |
| `info-root` | `info /` | 0 | json |
| `info-file` | `info <path>` | 0 | json |
| `share-list` | `share-list 1 2` | 0 | json |
| `download-url-only` | `download <path>` | 0 | json |
| `list-stream-ndjson` | `list / --stream` | 0 | ndjson(10 行) |
| `error-create-noargs` | `create` | 1 | json |
| `error-upload-noargs` | `upload` | 1 | json |
| `error-share-noargs` | `share` | 1 | json |
| `error-info-missing` | `info <path>` | 1 | json |

## 顶层信封

成功：`{"success":true,"code":"OK","message":"...","data":null}`；
失败：`{"success":false,"code":"INVALID_ARGS | FILE_NOT_FOUND","message":"..."}`（失败态没有 data）。
`data` 的形状按命令不同，见下。`list / --stream` 例外，是 **NDJSON**（每行一个信封）。

## 各命令信封骨架（脱敏）

### `version`

```json
{
  "success": true,
  "code": "OK",
  "message": "kuake v1.5.0",
  "data": {
    "version": "v1.5.0"
  }
}
```

### `user`

```json
{
  "success": true,
  "code": "OK",
  "message": "get user info success",
  "data": {
    "avatarUri": "<redacted>",
    "config": {},
    "member_type": "SUPER_VIP",
    "mobilekps": "<redacted>",
    "nickname": "<redacted>",
    "super_vip_exp_at": 1795449600000,
    "total_capacity": 28587302322176,
    "use_capacity": 126622659933
  }
}
```

### `list-root`

```json
{
  "success": true,
  "code": "OK",
  "message": "列出目录成功",
  "data": {
    "list": [
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794228459,
        "mtime": 1794460118,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794228459487,
        "updated_at": 1794460118601
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794373737,
        "mtime": 1794389284,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794373737160,
        "updated_at": 1794389284427
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794228467,
        "mtime": 1794373977,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794228467207,
        "updated_at": 1794373977505
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794367705,
        "mtime": 1794367705,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794367705538,
        "updated_at": 1794367705538
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794280833,
        "mtime": 1794325658,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794280833660,
        "updated_at": 1794325658872
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794228467,
        "mtime": 1794228564,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794228467669,
        "updated_at": 1794228564136
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794228468,
        "mtime": 1794228540,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794228468638,
        "updated_at": 1794228540772
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794228468,
        "mtime": 1794228538,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794228468168,
        "updated_at": 1794228538568
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794228466,
        "mtime": 1794228477,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794228466620,
        "updated_at": 1794228477640
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 958,
        "ctime": 1794228553,
        "mtime": 1794228553,
        "dir": false,
        "download_url": "<redacted>",
        "created_at": 1794228553767,
        "updated_at": 1794228553767
      }
    ]
  }
}
```

### `list-subdir`

```json
{
  "success": true,
  "code": "OK",
  "message": "列出目录成功",
  "data": {
    "list": [
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1794460118,
        "mtime": 1794460118,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1794460118162,
        "updated_at": 1794460118601
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1715266728,
        "mtime": 1794389267,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1715266728874,
        "updated_at": 1794389267393
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1705650126,
        "mtime": 1794228545,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1705650126586,
        "updated_at": 1794228545882
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1792556108,
        "mtime": 1794228544,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1792556108966,
        "updated_at": 1794228544636
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1792474522,
        "mtime": 1794228544,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1792474522852,
        "updated_at": 1794228544004
      },
      {
        "fid": "<redacted>",
        "file_name": "<redacted>",
        "path": "<redacted>",
        "size": 0,
        "ctime": 1792556112,
        "mtime": 1794228460,
        "dir": true,
        "download_url": "<redacted>",
        "created_at": 1792556112494,
        "updated_at": 1794228460407
      }
    ]
  }
}
```

### `info-root`

```json
{
  "success": true,
  "code": "OK",
  "message": "根目录",
  "data": {
    "dir": true,
    "fid": "<redacted>",
    "file_name": "<redacted>",
    "is_directory": true,
    "path": "<redacted>",
    "size": 0
  }
}
```

### `info-file`

```json
{
  "success": true,
  "code": "OK",
  "message": "获取文件信息成功",
  "data": {
    "ctime": 1794228553,
    "dir": false,
    "download_url": "<redacted>",
    "fid": "<redacted>",
    "file_name": "<redacted>",
    "mtime": 1794228553,
    "path": "<redacted>",
    "size": 958
  }
}
```

### `share-list`

```json
{
  "success": true,
  "code": "OK",
  "message": "Get share list successfully",
  "data": {
    "list": [
      {
        "all_file_num": 1,
        "audit_status": 4,
        "click_pv": -1,
        "created_at": 1794453672125,
        "download_pv": 0,
        "download_pvlimited": false,
        "expired_at": 4102416000000,
        "expired_left": "<volatile>",
        "expired_type": 1,
        "file_num": 1,
        "file_only_num": 1,
        "first_fid": "<redacted>",
        "first_file": {
          "_extra": {},
          "album_dir": false,
          "backup_source": false,
          "ban": false,
          "category": 4,
          "created_at": 1794228553767,
          "cur_version_or_default": 0,
          "dir": false,
          "duration": 0,
          "ensure_valid_save_as_layer": 1,
          "fid": "<redacted>",
          "file": true,
          "file_name": "<redacted>",
          "file_name_hl_end": 0,
          "file_name_hl_start": 0,
          "file_type": 1,
          "format_type": "text/x-web-markdown",
          "fps": 0,
          "like": 0,
          "more_than_one_layer": false,
          "name_space": 0,
          "offline_source": false,
          "owner_drive_type_or_default": 0,
          "risk_type": 0,
          "save_as_source": false,
          "scrape_status": 0,
          "series_dir": false,
          "size": 958,
          "tag_list": [],
          "updated_at": 1794228553767,
          "upload_camera_root_dir": false
        },
        "first_layer_file_categories": [
          4
        ],
        "is_all_image_file": 0,
        "is_owner": 1,
        "partial_violation": false,
        "path_info": "<redacted>",
        "pic_total": 0,
        "pwd_id": "<redacted>",
        "save_pv": 0,
        "share_id": "<redacted>",
        "share_type": 0,
        "share_url": "<redacted>",
        "size": 958,
        "status": 1,
        "stoken": "<redacted>",
        "title": "<redacted>",
        "update_score": 1794453672125,
        "updated_at": 1794453672440,
        "url_type": 1,
        "video_total": 0,
        "violation_cnt": 0,
        "visit_user_count": 0
      },
      {
        "all_file_num": 1,
        "audit_status": 4,
        "click_pv": -1,
        "created_at": 1794453666686,
        "download_pv": 0,
        "download_pvlimited": false,
        "expired_at": 4102416000000,
        "expired_left": "<volatile>",
        "expired_type": 1,
        "file_num": 1,
        "file_only_num": 1,
        "first_fid": "<redacted>",
        "first_file": {
          "_extra": {},
          "album_dir": false,
          "backup_source": false,
          "ban": false,
          "category": 4,
          "created_at": 1794228553767,
          "cur_version_or_default": 0,
          "dir": false,
          "duration": 0,
          "ensure_valid_save_as_layer": 1,
          "fid": "<redacted>",
          "file": true,
          "file_name": "<redacted>",
          "file_name_hl_end": 0,
          "file_name_hl_start": 0,
          "file_type": 1,
          "format_type": "text/x-web-markdown",
          "fps": 0,
          "like": 0,
          "more_than_one_layer": false,
          "name_space": 0,
          "offline_source": false,
          "owner_drive_type_or_default": 0,
          "risk_type": 0,
          "save_as_source": false,
          "scrape_status": 0,
          "series_dir": false,
          "size": 958,
          "tag_list": [],
          "updated_at": 1794228553767,
          "upload_camera_root_dir": false
        },
        "first_layer_file_categories": [
          4
        ],
        "is_all_image_file": 0,
        "is_owner": 1,
        "partial_violation": false,
        "path_info": "<redacted>",
        "pic_total": 0,
        "pwd_id": "<redacted>",
        "save_pv": 0,
        "share_id": "<redacted>",
        "share_type": 0,
        "share_url": "<redacted>",
        "size": 958,
        "status": 1,
        "stoken": "<redacted>",
        "title": "<redacted>",
        "update_score": 1794453666686,
        "updated_at": 1794453666922,
        "url_type": 1,
        "video_total": 0,
        "violation_cnt": 0,
        "visit_user_count": 0
      }
    ],
    "notify_follow": {
      "allow": 0
    }
  }
}
```

### `download-url-only`

```json
{
  "success": true,
  "code": "OK",
  "message": "Download URL retrieved successfully",
  "data": {
    "download_url": "<redacted>",
    "fid": "<redacted>",
    "path": "<redacted>"
  }
}
```

### `list-stream-ndjson`

```json
{
  "success": true,
  "code": "OK",
  "message": "OK",
  "data": {
    "created_at": 1794228459487,
    "ctime": 1794228459,
    "dir": true,
    "download_url": "<redacted>",
    "fid": "<redacted>",
    "file_name": "<redacted>",
    "l_created_at": 0,
    "l_updated_at": 0,
    "mtime": 1794460118,
    "path": "<redacted>",
    "size": 0,
    "updated_at": 1794460118601
  }
}
```

### `error-create-noargs`

```json
{
  "success": false,
  "code": "INVALID_ARGS",
  "message": "Usage: create <name> <pdir> (all parameters must be quoted, e.g., create 'folder(1)' '/')"
}
```

### `error-upload-noargs`

```json
{
  "success": false,
  "code": "INVALID_ARGS",
  "message": "Usage: upload <file> <dest> [--max_upload_parallel N] [--policy skip|overwrite|rsync] (all parameters must be quoted)"
}
```

### `error-share-noargs`

```json
{
  "success": false,
  "code": "INVALID_ARGS",
  "message": "Usage: share <path> <days> <passcode> (path and passcode must be quoted, e.g., share \"file(1).txt\" 7 \"false\")"
}
```

### `error-info-missing`

```json
{
  "success": false,
  "code": "FILE_NOT_FOUND",
  "message": "file not found: /__kuake_studio_dump_missing__"
}
```

## kuake help（stderr，非 JSON）

```text
Quark Cloud Drive CLI Tool

Usage:
  kuake [options] <command> [arguments...]

Options:
  -cookies, --cookies <value>  Specify cookie value directly (only when KUAKE_COOKIE empty after trim;
                                adds __pus= prefix)
  -v, --version                Show version information

Auth:
  Env cookie: full KUAKE_COOKIE (after trim+normalize) OR split KUAKE_PUS + KUAKE_PUUS (values only, no __pus=/__puus= prefix), then -cookies/--cookies.
  BREAKING; see CHANGELOG.
  Optional .env: if .env exists in cwd, load it before creating the client (does not override existing env vars). Set KUAKE_LOAD_DOTENV=0 to disable.

Commands:
  user                        Get user information
  list [path] [--stream]     List directory (default: "/")
                              Use --stream to output one JSON per line for pipeline mode
  info <path>                 Get file/folder info (supports pipe mode)
  download <path> [dest]      Get file download URL, or download to local file if dest given (supports pipe mode)
  upload <file> <dest> [--max_upload_parallel N]
                              Upload file (all parameters must be quoted)
  create <name> <pdir>        Create folder (use "/" for root)
  move <src> <dest>           Move file/folder
  copy <src> <dest>           Copy file/folder
  rename <path> <newName>     Rename file/folder
  delete <path>               Delete file/folder (supports pipe mode)
  share <path> <days> <passcode>  Create share link
                                days: 0=permanent, 1/7/30=days
                                passcode: "true" or "false"
  share-delete <share_id_or_path>...  Delete share(s) by share ID(s) or file path(s)
  share-list [page] [size] [orderField] [orderType]  Get my share list
                                page: page number (default: 1)
                                size: page size (default: 50)
                                orderField: sort field (default: "created_at")
                                orderType: "asc" or "desc" (default: "desc")
  share-save <share_link> [passcode] [dest_dir]  Save shared files to your drive
                                share_link: share link (e.g., "https://pan.quark.cn/s/xxx")
                                passcode: extraction code (optional, auto-extracted from link if present)
                                dest_dir: destination directory (default: "/")
  version                     Show version information
  help                           Show help

Examples:
  kuake user
  kuake list "/"
  kuake info "/file.txt"
  kuake download "/file.txt"
  kuake download "/file.txt" .
  kuake download "/file.txt" ./local.zip
  kuake upload "file.txt" "/folder/file.txt"
  kuake upload "file.txt" "/folder/file.txt" --max_upload_parallel 4
  kuake create "folder" "/"
  kuake move "/file.txt" "/folder/"
  kuake share "/file.txt" 7 "false"
  kuake share-delete "fdd8bfd93f21491ab80122538bec310d"
  kuake share-delete "/file.txt"
  kuake share-list
  kuake share-list 1 50 "created_at" "desc"
  kuake share-save "https://pan.quark.cn/s/xxx"
  kuake share-save "https://pan.quark.cn/s/xxx" "1234" "/folder"
  
  # Using -cookies parameter:
  kuake -cookies "your_cookie_value_here" user
  kuake -cookies "your_cookie_value_here" upload "file.txt" "/folder/file.txt"

Pipeline Mode:
  Commands can be chained using Unix pipes. When stdin has data, commands automatically
  switch to pipe mode and process input line by line.
  
  Examples:
    # List files and delete them
    kuake list "/photos" --stream | kuake delete
    
    # List files and get info for each
    kuake list "/" --stream | kuake info
    
    # List files and get download URLs
    kuake list "/documents" --stream | kuake download
    
    # List files, filter with jq, then delete
    kuake list "/" --stream | jq -r 'select(.size > 1000000) | .path' | kuake delete

Notes:
  - All path parameters must be quoted
  - Root directory is "/"
  - Upload parallel: --max_upload_parallel overrides KUAKE_UPLOAD_PARALLEL when both apply; if only
    env is set (1-16) it is used when the flag is omitted (default 4)
  - Results output as JSON to stdout
  - Exit code: 0=success, 1=failure
  - If KUAKE_COOKIE is set (non-empty after trim), it wins over -cookies
  - In pipe mode, each input line should be a JSON object with "path" or "fid" field
  - Use --stream with list command to output one JSON per line for pipeline processing
```

> 备注：`--cli ... --json` 是 kuake-studio 自己的 lilyco CLI 包装；`--json` 要放最后。
> 默认后端已是内置原生夸克 API，只有显式 `KUAKE_STUDIO_BACKEND=cli` 才真的 fork 本机 kuake 子进程。
