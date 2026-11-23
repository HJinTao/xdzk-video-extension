package io.github.pais1ey.xdzk;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.view.View;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.util.Locale;
import java.util.regex.*;
import org.json.JSONObject;

public class CourseActivity extends Activity {
    private static final String ASSETS = "appassets.androidplatform.net";
    private static final String HOME = "https://" + ASSETS + "/mobile.html";
    private static final Pattern LINK = Pattern.compile("https?://[^\\s<>，。）、]+");
    private WebView web;
    private LinearLayout tools;
    private String reader;
    private final Handler handler = new Handler(android.os.Looper.getMainLooper());
    private final Runnable detect = () -> collect(false);
    private int generation, attempts;
    private String lastSingle = "";
    private ValueCallback<Uri[]> fileCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        tools = new LinearLayout(this);
        button("播放器首页", v -> web.loadUrl(HOME));
        button("播放这节课", v -> collect(true));
        tools.setVisibility(View.GONE);
        layout.addView(tools);
        web = new WebView(this);
        layout.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new Pages());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try { startActivityForResult(pick, 1); }
                catch (android.content.ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback = null; }
                return true;
            }
        });
        try (InputStream stream = getAssets().open("reader.js"); java.util.Scanner input = new java.util.Scanner(stream, "UTF-8")) {
            reader = input.useDelimiter("\\A").next();
        } catch (IOException e) { throw new IllegalStateException("录播读取组件缺失", e); }
        openIntent(getIntent());
    }

    private void button(String title, View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(title); b.setOnClickListener(click);
        tools.addView(b, new LinearLayout.LayoutParams(0, -2, 1));
    }

    private boolean school(Uri url) {
        return url != null && ("http".equals(url.getScheme()) || "https".equals(url.getScheme()))
            && "newes.chaoxing.com".equals(url.getHost()) && url.getUserInfo() == null;
    }

    private void openIntent(Intent intent) {
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            Matcher matches = LINK.matcher(text == null ? "" : text);
            while (matches.find()) {
                Uri url = Uri.parse(matches.group());
                if (school(url) && url.getPath() != null && url.getPath().startsWith("/xidianpj/")) { web.loadUrl(url.toString()); return; }
            }
            Toast.makeText(this, "请分享西电智课的课程播放网址。", Toast.LENGTH_LONG).show();
        }
        web.loadUrl(HOME);
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); openIntent(intent); }

    private void collect(boolean manual) {
        String address = web.getUrl();
        if (address == null || !school(Uri.parse(address))) {
            if (manual) toast("请在应用内完成学校登录，再打开对应课次。");
            return;
        }
        handler.removeCallbacks(detect);
        int request = generation;
        web.evaluateJavascript(reader, json -> {
            if (request != generation || !address.equals(web.getUrl()) || isFinishing()) return;
            try {
                JSONObject lesson = new JSONObject(json);
                int count = lesson.getJSONArray("media").length();
                String single = count == 1 ? lesson.getJSONArray("media").getJSONObject(0).getString("url") : "";
                boolean ready = count == 1 && lesson.optInt("videoCount") == 1 && single.equals(lastSingle);
                lastSingle = single;
                if (count == 2 || ready || (manual && count == 1)) {
                    generation++;
                    web.loadUrl(HOME + "#lesson=" + Uri.encode(json));
                    return;
                }
            } catch (org.json.JSONException ignored) { /* Login and course lists may have no player yet. */ }
            if (manual) toast("请进入这节课的回放并点播放，再点「播放这节课」。");
            if (++attempts < 60) handler.postDelayed(detect, 1500);
        });
    }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    private class Pages extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest req) {
            String scheme = req.getUrl().getScheme();
            return !"https".equals(scheme) && !"http".equals(scheme);
        }
        @Override public void onPageStarted(WebView w, String url, Bitmap icon) {
            generation++; attempts = 0; lastSingle = ""; handler.removeCallbacks(detect);
            tools.setVisibility(ASSETS.equals(Uri.parse(url).getHost()) ? View.GONE : View.VISIBLE);
        }
        @Override public void onPageFinished(WebView w, String url) {
            if (url.equals(w.getUrl()) && school(Uri.parse(url))) { handler.removeCallbacks(detect); handler.postDelayed(detect, 400); }
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView w, WebResourceRequest req) {
            Uri uri = req.getUrl();
            if (!ASSETS.equals(uri.getHost())) return null;
            String path = uri.getPath();
            if ("https".equals(uri.getScheme()) && path != null && path.matches("/[a-zA-Z0-9_./-]+") && !path.contains("..")) {
                String name = path.substring(1), lower = name.toLowerCase(Locale.ROOT);
                String mime = lower.endsWith(".js") ? "text/javascript" : lower.endsWith(".css") ? "text/css" :
                    lower.endsWith(".html") ? "text/html" : lower.endsWith(".png") ? "image/png" : "text/plain";
                try { return new WebResourceResponse(mime, lower.endsWith(".png") ? null : "utf-8", getAssets().open("web/" + name)); }
                catch (IOException ignored) { /* Return a local 404. */ }
            }
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == 1 && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        }
    }
    @Override public void onBackPressed() {
        String url = web.getUrl();
        if (url != null && ASSETS.equals(Uri.parse(url).getHost())) {
            if (!HOME.equals(url)) web.loadUrl(HOME); else super.onBackPressed();
        } else if (web.canGoBack()) web.goBack(); else web.loadUrl(HOME);
    }
    @Override protected void onPause() { web.onPause(); handler.removeCallbacks(detect); super.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); handler.removeCallbacks(detect); handler.postDelayed(detect, 500); }
    @Override protected void onDestroy() { generation++; handler.removeCallbacks(detect); web.destroy(); super.onDestroy(); }
}
