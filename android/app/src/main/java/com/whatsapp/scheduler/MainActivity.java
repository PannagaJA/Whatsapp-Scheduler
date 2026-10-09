package com.whatsapp.scheduler;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.ContactsContract;
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
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    private static final String APP_URL = "https://my-whatsapp-scheduler.onrender.com";
    private static final int PERMISSION_REQ_CONTACTS = 101;
    private static final int FILE_CHOOSER_REQ = 102;

    private WebView webView;
    private SwipeRefreshLayout swipeRefreshLayout;
    private ValueCallback<Uri[]> filePathCallback;
    private final ExecutorService executorService = Executors.newSingleThreadExecutor();

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

        // Only allow pull-to-refresh when at the top of webview
        swipeRefreshLayout.setOnRefreshListener(() -> webView.reload());
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

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Add Native JavaScript Bridge
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
                // Safely evaluate javascript in webview
                String script = String.format(
                        "if (window.onNativeContactsImported) { window.onNativeContactsImported(%s); }",
                        jsonPayload
                );
                webView.evaluateJavascript(script, null);
            });
        });
    }
}
