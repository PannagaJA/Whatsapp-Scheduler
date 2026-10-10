package com.whatsapp.scheduler;

import android.content.Context;
import android.content.ClipboardManager;
import android.content.ClipData;

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
import java.util.Locale;
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
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String url = uri.toString();
                boolean isMainFrame = request.isForMainFrame();

                if (url.startsWith("https://wa.me/") || url.startsWith("whatsapp://") || url.startsWith("tel:") || url.startsWith("mailto:")) {
                    if (isMainFrame) {
                        try {
                            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                            startActivity(intent);
                        } catch (Exception e) {
                            Toast.makeText(MainActivity.this, "App not installed", Toast.LENGTH_SHORT).show();
                        }
                    }
                    return true;
                }

                String host = uri.getHost();
                String appHost = Uri.parse(APP_URL).getHost();
                if (host != null && !host.equalsIgnoreCase(appHost) && !host.equals("localhost") && !host.equals("127.0.0.1")) {
                    if (isMainFrame) {
                        try {
                            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                            startActivity(intent);
                        } catch (Exception ignored) {}
                    }
                    return true;
                }

                if (!isMainFrame && host != null && !host.equalsIgnoreCase(appHost) && !host.equals("localhost") && !host.equals("127.0.0.1")) {
                    return true;
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
                    File apkToInstall = new File(pendingInstallApkPath);
                    pendingInstallApkPath = null;
                    triggerPackageInstaller(apkToInstall);
                } else {
                    pendingInstallApkPath = null;
                    reportUpdateError("Install permission was not granted.");
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
        public void copyToClipboard(String text) {
            if (text == null) return;
            final String sanitized = text.replaceAll("[\\p{Cntrl}&&[^\r\n\t]]", "").trim();
            final String safeText = sanitized.length() > 500 ? sanitized.substring(0, 500) : sanitized;
            if (safeText.isEmpty()) return;

            runOnUiThread(() -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("WhatsApp Code", safeText);
                if (clipboard != null) {
                    clipboard.setPrimaryClip(clip);
                    Toast.makeText(MainActivity.this, "Copied to clipboard", Toast.LENGTH_SHORT).show();
                }
            });
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
            // SEC-002: Strict URL and Protocol Whitelist Check
            if (downloadUrl == null || !downloadUrl.startsWith("https://")) {
                reportUpdateError("Update error: Insecure download URL.");
                return;
            }

            try {
                Uri parsedUri = Uri.parse(downloadUrl);
                String host = parsedUri.getHost();
                if (host == null || (!host.equalsIgnoreCase("github.com") && !host.endsWith(".githubusercontent.com"))) {
                    reportUpdateError("Update error: Untrusted download source.");
                    return;
                }
            } catch (Exception e) {
                reportUpdateError("Update error: Invalid download URL.");
                return;
            }

            runOnUiThread(() -> {
                Toast.makeText(MainActivity.this, "Downloading verified WhatsApp Scheduler update…", Toast.LENGTH_SHORT).show();
            });

            executorService.execute(() -> {
                File apkFile = null;
                try {
                    URL targetUrl = new URL(downloadUrl);
                    HttpURLConnection conn = (HttpURLConnection) targetUrl.openConnection();
                    conn.setRequestMethod("GET");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(true);
                    conn.connect();

                    int responseCode = conn.getResponseCode();

                    // Follow redirect manually if needed with strict host whitelist validation
                    if (responseCode == HttpURLConnection.HTTP_MOVED_TEMP ||
                        responseCode == HttpURLConnection.HTTP_MOVED_PERM ||
                        responseCode == HttpURLConnection.HTTP_SEE_OTHER ||
                        responseCode == 307 || responseCode == 308) {
                        String redirectUrl = conn.getHeaderField("Location");
                        if (redirectUrl != null) {
                            Uri redirectUri = Uri.parse(redirectUrl);
                            String redirectHost = redirectUri.getHost();
                            if (redirectHost == null || (!redirectHost.equalsIgnoreCase("github.com") && !redirectHost.endsWith(".githubusercontent.com"))) {
                                conn.disconnect();
                                throw new SecurityException("Untrusted redirect host: " + redirectHost);
                            }
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
                        reportUpdateError("Download failed: HTTP " + responseCode);
                        return;
                    }

                    File downloadsDir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (downloadsDir == null) downloadsDir = getCacheDir();
                    apkFile = new File(downloadsDir, "WhatsApp-Scheduler-update.apk");
                    if (apkFile.exists()) apkFile.delete();

                    final long fileLength = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
                            ? conn.getContentLengthLong()
                            : conn.getContentLength();

                    InputStream inputStream = conn.getInputStream();
                    FileOutputStream outputStream = new FileOutputStream(apkFile);

                    byte[] buffer = new byte[8192];
                    int bytesRead;
                    long totalBytesRead = 0;
                    long lastUpdateTime = 0;

                    while ((bytesRead = inputStream.read(buffer)) != -1) {
                        outputStream.write(buffer, 0, bytesRead);
                        totalBytesRead += bytesRead;

                        long now = System.currentTimeMillis();
                        if (now - lastUpdateTime > 80) {
                            lastUpdateTime = now;
                            final int progressPercent = (fileLength > 0) ? (int) ((totalBytesRead * 100) / fileLength) : -1;
                            final long curBytes = totalBytesRead;
                            final long totalBytes = fileLength;
                            runOnUiThread(() -> {
                                if (webView != null) {
                                    String js = String.format(Locale.US,
                                        "if (typeof window.onUpdateDownloadProgress === 'function') window.onUpdateDownloadProgress(%d, %d, %d);",
                                        progressPercent, curBytes, totalBytes);
                                    webView.evaluateJavascript(js, null);
                                }
                            });
                        }
                    }

                    outputStream.flush();
                    outputStream.close();
                    inputStream.close();
                    conn.disconnect();

                    final long finalBytes = totalBytesRead;
                    runOnUiThread(() -> {
                        if (webView != null) {
                            String js = String.format(Locale.US,
                                "if (typeof window.onUpdateDownloadProgress === 'function') window.onUpdateDownloadProgress(100, %d, %d);",
                                finalBytes, finalBytes);
                            webView.evaluateJavascript(js, null);
                        }
                    });

                    // SEC-002: Programmatic Package Identity & Signature Continuity Verification
                    final File verifiedApk = apkFile;
                    verifyApkIntegrityAndSignatures(verifiedApk);

                    runOnUiThread(() -> triggerPackageInstaller(verifiedApk));

                } catch (Exception e) {
                    e.printStackTrace();
                    if (apkFile != null && apkFile.exists()) {
                        apkFile.delete();
                    }
                    final String errText = e.getMessage() != null ? e.getMessage() : "Security verification failed";
                    reportUpdateError("Update error: " + errText);
                }
            });
        }

        private void verifyApkIntegrityAndSignatures(File apkFile) throws SecurityException {
            if (apkFile == null || !apkFile.exists()) {
                throw new SecurityException("Downloaded update archive not found.");
            }

            PackageManager pm = getPackageManager();
            PackageInfo downloadedInfo = pm.getPackageArchiveInfo(
                    apkFile.getAbsolutePath(),
                    PackageManager.GET_SIGNATURES | PackageManager.GET_ACTIVITIES
            );

            if (downloadedInfo == null) {
                apkFile.delete();
                throw new SecurityException("Downloaded archive is not a valid Android APK.");
            }

            // 1. Verify Package Name
            if (!getPackageName().equals(downloadedInfo.packageName)) {
                apkFile.delete();
                throw new SecurityException("Package ID mismatch. Expected " + getPackageName() + ", got " + downloadedInfo.packageName);
            }

            // 2. Verify Signing Certificate Continuity against Current Running Installation
            try {
                PackageInfo currentInfo = pm.getPackageInfo(getPackageName(), PackageManager.GET_SIGNATURES);
                if (currentInfo.signatures != null && downloadedInfo.signatures != null) {
                    boolean signatureMatches = false;
                    for (android.content.pm.Signature curSig : currentInfo.signatures) {
                        for (android.content.pm.Signature downSig : downloadedInfo.signatures) {
                            if (curSig.equals(downSig)) {
                                signatureMatches = true;
                                break;
                            }
                        }
                        if (signatureMatches) break;
                    }

                    if (!signatureMatches) {
                        apkFile.delete();
                        throw new SecurityException("Signing certificate mismatch! Untrusted developer key.");
                    }
                }
            } catch (PackageManager.NameNotFoundException e) {
                // If package info cannot be queried, fail closed
                apkFile.delete();
                throw new SecurityException("Could not verify running application signatures.");
            }
        }
    }

    private void triggerPackageInstaller(File apkFile) {
        if (apkFile == null || !apkFile.exists()) {
            reportUpdateError("Update error: Downloaded update archive not found.");
            return;
        }

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

            runOnUiThread(() -> {
                if (webView != null) {
                    webView.evaluateJavascript("if (typeof window.onUpdateDownloadComplete === 'function') window.onUpdateDownloadComplete(true);", null);
                }
            });
        } catch (Exception e) {
            reportUpdateError("Failed to launch installer: " + e.getMessage());
        }
    }

    private void reportUpdateError(String errMsg) {
        final String safeMsg = (errMsg != null) ? errMsg : "Security verification failed";
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript("if (typeof window.onUpdateDownloadError === 'function') window.onUpdateDownloadError('" + safeMsg.replace("'", "\\'") + "');", null);
            }
            Toast.makeText(MainActivity.this, safeMsg, Toast.LENGTH_LONG).show();
        });
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
