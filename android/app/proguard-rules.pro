# ProGuard / R8 rules for WhatsApp Scheduler
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Keep the AndroidBridge class and methods for WebView native bridge
-keep class com.whatsapp.scheduler.MainActivity$AndroidBridge { *; }

# Keep FileProvider for secure APK update installation and file sharing
-keep class androidx.core.content.FileProvider { *; }

# Keep AndroidX & Material design components
-dontwarn androidx.**
-dontwarn com.google.android.material.**
