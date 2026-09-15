package com.voicetype.app;

/*
 * 音转文 · 安卓入口（完全离线版）
 *
 * 和上一版最大的不同：不再用 TWA 打开线上网页。
 * 离线版的所有资源（页面、离线推理运行时、540MB 模型）都随 APK 一起发出去，
 * 通过一个"虚拟 HTTPS 源"在本机提供：
 *
 *     https://appassets.androidplatform.net/assets/web/index.html
 *                          ↑ 这个域名由下面的 AssetServer 拦截，永不联网
 *
 * 为什么必须造一个 https 源，而不是直接 file:///android_asset/：
 * 浏览器的 getUserMedia（录音）只在"安全上下文"里可用。file:// 不算安全上下文，
 * 直接加载本地文件会导致麦克风被浏览器直接拒绝，且不给用户任何提示。
 * https://appassets.androidplatform.net 被系统认为是可信的 https 源，
 * 录音、Service Worker、WASM 都能正常工作。
 *
 * 为什么不用 androidx.webkit 的 WebViewAssetLoader：
 * 它的 AssetsPathHandler 用 MimeTypeMap 猜 MIME，而 .mjs 在安卓的映射表里
 * 是缺失的 —— 返回 null 就不写 Content-Type。WebView 加载 ES module 时
 * 一旦发现 MIME 为空，会直接拒绝执行：
 *     "Failed to load module script: Expected a JavaScript module script
 *      but the server responded with a MIME type of ''"
 * 离线引擎正是靠 import() 加载 vendor/ort/*.mjs 的，踩上这个坑就是白屏 + 无报错。
 * 所以这里自己实现拦截器，把 .mjs / .wasm / .onnx 的 MIME 钉死。
 */

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String TAG = "VoiceType";

    /** 虚拟源。改这里要同时改 shouldInterceptRequest 里的 host 判断。 */
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    /** 资源在 APK 里的根目录（assets/web/），URL 前缀是 /assets/web/ */
    private static final String ASSET_ROOT = "web";
    private static final String START_URL =
            "https://" + ASSET_HOST + "/assets/" + ASSET_ROOT + "/index.html";

    private static final int REQ_AUDIO = 1001;
    private static final int REQ_STORAGE = 1002;

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);

        // 先要录音权限，再起 WebView —— 反过来的话，页面加载时若已经请求
        // getUserMedia，会先拿到一次拒绝，用户之后授权了还得手动重试。
        requestPermissionsThenSetup();
    }

    private void requestPermissionsThenSetup() {
        java.util.ArrayList<String> need = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        // Android 9 及以下写公共「下载」目录需要存储权限；10 以上走 MediaStore 不需要
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                   != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        if (need.isEmpty()) {
            setupWebView();
            return;
        }
        requestPermissions(need.toArray(new String[0]), REQ_AUDIO);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // 即使用户拒绝也照常进主界面：没录音权限时 onPermissionRequest 会拒绝
        // getUserMedia，但历史记录、导出 txt/html、设置都还能用。
        // 直接白屏是最糟的处理方式。
        if (requestCode == REQ_AUDIO) setupWebView();
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#f4f5f9"));   // 避免白闪

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage：历史记录 / 偏好设置
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        // 全程走虚拟 https 源，不需要 file:// 和 content://
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " VoiceType-App/2.0");

        // 落盘桥：网页里 window.__yzwSave.save(名, 内容, MIME)
        webView.addJavascriptInterface(new SaveBridge(this), "__yzwSave");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                WebResourceResponse local = serveLocalAsset(req);
                return local != null ? local : super.shouldInterceptRequest(view, req);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // 站内（虚拟源）自己处理
                if (u.getHost() != null && ASSET_HOST.equals(u.getHost())) return false;
                // 其他一律交给系统浏览器，别在 App 里开出一个没有地址栏的网页
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 宿主自己有 RECORD_AUDIO 才能给网页授权，
                // 否则授权了也录不到声音，只会让用户更困惑。
                boolean hasAudio = checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED;
                String[] resources = request.getResources();
                if (hasAudio) {
                    for (String r : resources) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                            request.grant(resources);
                            return;
                        }
                    }
                }
                request.deny();
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // 只有 debug 版开远程调试，发布版关掉（避免任何被调试注入的面）
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.loadUrl(START_URL);
    }

    // ------------------------------------------------------------------
    // 本机资产服务：把 APK 里 assets/web/ 下的文件，以虚拟 https 源提供给 WebView
    // ------------------------------------------------------------------

    /**
     * 命中虚拟源就返回本地资源，否则返回 null（交回 WebView 正常处理）。
     * 这个方法在 WebView 的后台线程上被调用，可以直接做文件 I/O。
     */
    private WebResourceResponse serveLocalAsset(WebResourceRequest req) {
        if (req == null) return null;
        Uri u = req.getUrl();
        if (u == null || !ASSET_HOST.equals(u.getHost())) return null;
        // 只放行 GET / HEAD；其他方法一律 405
        String method = req.getMethod();
        if (method != null && !"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method)) {
            return new WebResourceResponse("text/plain", "utf-8", 405, "Method Not Allowed",
                    noStore(), emptyStream());
        }

        String path = u.getPath();                      // /assets/web/js/app.js
        if (path == null) return null;
        String prefix = "/assets/" + ASSET_ROOT + "/";
        if (!path.startsWith(prefix)) {
            // 根路径直接给首页，省得用户看到 404
            if (path.equals("/") || path.equals("/assets/" + ASSET_ROOT) || path.isEmpty()) {
                path = prefix + "index.html";
            } else {
                return null;
            }
        }

        String rel = path.substring(prefix.length());
        if (rel.isEmpty()) rel = "index.html";
        // 目录请求补 index.html
        if (rel.endsWith("/")) rel += "index.html";
        // 路径穿越防护：AssetManager 本身不会跳出 assets/，
        // 但显式挡一层，别把可疑路径交给下层去判断
        if (rel.contains("..") || rel.startsWith("/")) return null;

        AssetManager am = getAssets();
        InputStream is;
        try {
            is = am.open(ASSET_ROOT + "/" + rel, AssetManager.ACCESS_STREAMING);
        } catch (IOException e) {
            // 文件不存在 → 404。注意这里绝不能返回 index.html 顶包：
            // whisper.js 探测本地运行时靠的就是"拿到 404 才算没有"，
            // 用首页冒充会让它误判成"运行时存在"，然后卡在解析 HTML 上。
            Log.w(TAG, "本地资源不存在：" + rel);
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    noStore(), emptyStream());
        }

        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");

        // 跨源隔离（COOP + COEP）。
        //
        // 这两个头同时到位，页面里 window.crossOriginIsolated 才会是 true，
        // SharedArrayBuffer 才存在，onnxruntime 的多线程 WASM 才真的起得来。
        // 没有它就只能单线程跑 —— 实测同一段 19.93 秒音频：
        // 单线程 77.7 秒，多线程 21.4 秒，差 3.6 倍。
        //
        // ⚠️ 但要如实说明：**在 Android WebView 上这条路目前不生效。**
        //    头确实发出去了（页面里 fetch(location.href) 能把它们读回来），
        //    但 WebView 的导航响应并不据此做隔离判定，crossOriginIsolated 恒为 false。
        //    为排除「是我们的拦截机制有问题」，用真实公共站点 vscode.dev
        //    （证书有效、自带完整 COOP+COEP）在同一 WebView 里对照，结果同样是 false。
        //    也就是说这是 **WebView 自身的限制**，不是这里的写法问题。
        //    提供方已核实为完整版 com.google.android.webview 133.0.6943.137，非 stub。
        //
        //    代价：安卓端实际只能单线程 WASM。这一点暂时没有绕过办法。
        //    既然如此为什么还留着？因为它是**正确**的头，成本为零，
        //    将来 WebView 支持了、或换用别的壳时就能直接受益，不需要再改回来。
        headers.put("Cross-Origin-Opener-Policy", "same-origin");
        headers.put("Cross-Origin-Embedder-Policy", "require-corp");

        // COEP: require-corp 之下，跨源资源要么带 CORP 头，要么走 CORS 模式。
        // 我们的资源全在同一个虚拟源上，本来就不受约束；带上 CORP 是为了
        // 万一以后从别的源嵌入时不会被拦。
        headers.put("Cross-Origin-Resource-Policy", "cross-origin");

        // 一律不缓存。这里没有「可以省一次读盘」的余地。
        //
        // 原先给页面/脚本/wasm 发的是 `public, max-age=86400`，想着「重启后秒开」。
        // 这是错的，而且真的把我们坑了一次：
        //   WebView 的 HTTP 缓存按 URL 存，而虚拟源地址（appassets.androidplatform.net）
        //   在版本之间是**不变**的。于是覆盖安装新版本后，WebView 会继续用缓存里的
        //   **旧 JS**（最长 24 小时）。实测踩到的正是这一条 —— 旧的 whisper.js 去要
        //   encoder_model_quantized.onnx，而新包里只有 encoder_model_q4.onnx，
        //   请求 404，用户看到的就是「离线模型加载不出来」。
        //   换成清空应用数据就正常了，所以一度被误判成内存不足。
        //
        // 这些字节本来就躺在 APK 里，读它是本地操作、不走网络，
        // 缓存能省下的只是解压那几十毫秒；而一旦发版，代价是用户跑着旧代码，
        // 甚至像上面那样直接坏掉。两害相权，宁可不缓存。
        headers.put("Cache-Control", "no-store");

        return new WebResourceResponse(mimeOf(rel), null, 200, "OK", headers, is);
    }

    private static Map<String, String> noStore() {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return h;
    }

    private static InputStream emptyStream() {
        return new java.io.ByteArrayInputStream(new byte[0]);
    }

    /**
     * MIME 表。必须显式列出 .mjs / .wasm —— 安卓的 MimeTypeMap 不认识它们，
     * 猜不出来就会返回 null，WebView 随即拒绝执行 ES module。这是离线版最致命的一个坑。
     */
    private static String mimeOf(String rel) {
        String p = rel.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".onnx")) return "application/octet-stream";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
