package com.whatsapp.scheduler;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    private static final String APP_URL = "https://my-whatsapp-scheduler.onrender.com";
    private static final int PERMISSION_REQ_CONTACTS = 101;
    private static final int FILE_CHOOSER_REQ = 102;
    private static final int INSTALL_PERMISSION_REQ = 103;

    private WebView webView;
    private SwipeRefreshLayout swipeRefreshLayout;
    private ValueCallback<Uri[]> filePathCallback;
    private final ExecutorService executorService = Executors.newSingleThreadExecutor();
    private String pendingInstallApkPath = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        swipeRefreshLayout = findViewById(R.id.swipeRefreshLayout);
        webView = findViewById(R.id.webView);

        setupSwipeRefresh();
        setupWebView();

        webView.loadUrl(APP_URL);
    }

    private void setupSwipeRefresh() {
        swipeRefreshLayout.setColorSchemeColors(
            ContextCompat.getColor(this, R.color.primary),
            ContextCompat.getColor(this, R.color.accent)
        );
        swipeRefreshLayout.setProgressBackgroundColorSchemeColor(
            ContextCompat.getColor(this, R.color.background)
        );

        swipeRefreshLayout.setOnRefreshListener(() -> {
            webView.clearCache(true);
            webView.reload();
        });
        webView.getViewTreeObserver().addOnScrollChangedListener(() -> {
            swipeRefreshLayout.setEnabled(webView.getScrollY() == 0);
        });
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("https://wa.me/") || url.startsWith("whatsapp://") || url.startsWith("tel:") || url.startsWith("mailto:")) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        startActivity(intent);
                        return true;
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "App not installed", Toast.LENGTH_SHORT).show();
                    }
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                swipeRefreshLayout.setRefreshing(false);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQ);
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQ) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    } else if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        } else if (requestCode == INSTALL_PERMISSION_REQ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (getPackageManager().canRequestPackageInstalls() && pendingInstallApkPath != null) {
                    triggerPackageInstaller(new File(pendingInstallApkPath));
                }
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (executorService != null && !executorService.isShutdown()) {
            executorService.shutdown();
        }
        super.onDestroy();
    }

    // --- JavaScript Native Bridge ---
    public class AndroidBridge {

        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }

        @JavascriptInterface
        public String getAppVersionName() {
            try {
                PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pInfo.versionName;
            } catch (Exception e) {
                return "1.0.0";
            }
        }

        @JavascriptInterface
        public int getAppVersionCode() {
            try {
                PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pInfo.versionCode;
            } catch (Exception e) {
                return 1;
            }
        }

        @JavascriptInterface
        public void importAllContacts() {
            runOnUiThread(() -> {
                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_CONTACTS)
                        == PackageManager.PERMISSION_GRANTED) {
                    readAndSyncContacts();
                } else {
                    ActivityCompat.requestPermissions(
                            MainActivity.this,
                            new String[]{Manifest.permission.READ_CONTACTS},
                            PERMISSION_REQ_CONTACTS
                    );
                }
            });
        }

        @JavascriptInterface
        public void downloadAndInstallUpdate(final String downloadUrl) {
            runOnUiThread(() -> {
                Toast.makeText(MainActivity.this, "Downloading WhatsApp Scheduler update…", Toast.LENGTH_SHORT).show();
            });

            executorService.execute(() -> {
                try {
                    URL targetUrl = new URL(downloadUrl);
                    HttpURLConnection conn = (HttpURLConnection) targetUrl.openConnection();
                    conn.setRequestMethod("GET");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(true);
                    conn.connect();

                    int responseCode = conn.getResponseCode();

                    // Follow redirect manually if needed
                    if (responseCode == HttpURLConnection.HTTP_MOVED_TEMP ||
                        responseCode == HttpURLConnection.HTTP_MOVED_PERM ||
                        responseCode == HttpURLConnection.HTTP_SEE_OTHER ||
                        responseCode == 307 || responseCode == 308) {
                        String redirectUrl = conn.getHeaderField("Location");
                        if (redirectUrl != null) {
                            conn.disconnect();
                            targetUrl = new URL(redirectUrl);
                            conn = (HttpURLConnection) targetUrl.openConnection();
                            conn.setRequestMethod("GET");
                            conn.setConnectTimeout(15000);
                            conn.setReadTimeout(30000);
                            conn.connect();
                            responseCode = conn.getResponseCode();
                        }
                    }

                    if (responseCode != HttpURLConnection.HTTP_OK) {
                        final String errMsg = "Download failed: HTTP " + responseCode;
                        runOnUiThread(() -> Toast.makeText(MainActivity.this, errMsg, Toast.LENGTH_LONG).show());
                        return;
                    }

                    File downloadsDir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (downloadsDir == null) downloadsDir = getCacheDir();
                    final File apkFile = new File(downloadsDir, "WhatsApp-Scheduler-update.apk");
                    if (apkFile.exists()) apkFile.delete();

                    InputStream inputStream = conn.getInputStream();
                    FileOutputStream outputStream = new FileOutputStream(apkFile);

                    byte[] buffer = new byte[8192];
                    int bytesRead;
                    while ((bytesRead = inputStream.read(buffer)) != -1) {
                        outputStream.write(buffer, 0, bytesRead);
                    }

                    outputStream.flush();
                    outputStream.close();
                    inputStream.close();
                    conn.disconnect();

                    runOnUiThread(() -> triggerPackageInstaller(apkFile));

                } catch (Exception e) {
                    e.printStackTrace();
                    final String errText = e.getMessage() != null ? e.getMessage() : "Network error";
                    runOnUiThread(() -> {
                        Toast.makeText(MainActivity.this, "Update error: " + errText, Toast.LENGTH_LONG).show();
                        try {
                            Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl));
                            startActivity(browserIntent);
                        } catch (Exception ignored) {
                            // Fallback browser not available
                        }
                    });
                }
            });
        }
    }

    private void triggerPackageInstaller(File apkFile) {
        if (apkFile == null || !apkFile.exists()) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!getPackageManager().canRequestPackageInstalls()) {
                pendingInstallApkPath = apkFile.getAbsolutePath();
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                intent.setData(Uri.parse("package:" + getPackageName()));
                startActivityForResult(intent, INSTALL_PERMISSION_REQ);
                return;
            }
        }

        try {
            Uri apkUri = FileProvider.getUriForFile(
                    this,
                    getPackageName() + ".fileprovider",
                    apkFile
            );

            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(installIntent);
        } catch (Exception e) {
            Toast.makeText(this, "Failed to launch installer: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQ_CONTACTS) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                readAndSyncContacts();
            } else {
                Toast.makeText(this, "Contacts permission is required to import contacts", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void readAndSyncContacts() {
        Toast.makeText(this, "Reading phone contacts…", Toast.LENGTH_SHORT).show();

        executorService.execute(() -> {
            JSONArray contactsArray = new JSONArray();
            Set<String> seenPhones = new HashSet<>();

            String[] projection = new String[]{
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
            };

            Cursor cursor = null;
            try {
                cursor = getContentResolver().query(
                        ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                        projection,
                        null,
                        null,
                        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
                );

                if (cursor != null && cursor.moveToFirst()) {
                    int nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
                    int phoneIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);

                    do {
                        String name = nameIdx >= 0 ? cursor.getString(nameIdx) : "";
                        String rawPhone = phoneIdx >= 0 ? cursor.getString(phoneIdx) : "";

                        if (rawPhone != null) {
                            String digits = rawPhone.replaceAll("\\D+", "");
                            if (digits.length() >= 7 && !seenPhones.contains(digits)) {
                                seenPhones.add(digits);
                                JSONObject item = new JSONObject();
                                item.put("name", name != null ? name.trim() : "");
                                item.put("phone", digits);
                                contactsArray.put(item);
                            }
                        }
                    } while (cursor.moveToNext());
                }
            } catch (Exception e) {
                e.printStackTrace();
            } finally {
                if (cursor != null) {
                    cursor.close();
                }
            }

            final String jsonPayload = contactsArray.toString();

            runOnUiThread(() -> {
                String script = String.format(
                        "if (window.onNativeContactsImported) { window.onNativeContactsImported(%s); }",
                        jsonPayload
                );
                webView.evaluateJavascript(script, null);
            });
        });
    }
}
