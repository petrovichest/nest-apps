package com.codexnest.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

public class SelfHostedNotificationService extends Service {

    private static final String SERVICE_CHANNEL = "codexnest_connection";
    private static final String EVENT_CHANNEL = "codexnest_events";
    private static final int SERVICE_NOTIFICATION_ID = 41;
    private static final String STATE_PREFERENCES = "CodexNestNotifications";
    private static final String LAST_OBSERVED_AT = "lastObservedAt";
    private static final String UI_LANGUAGE = "uiLanguage";
    private static final Object OBSERVED_FRAMES_LOCK = new Object();
    private static final Deque<String> pendingObservedFrames = new ArrayDeque<>();
    private static volatile boolean appVisible;
    private static volatile String activeThreadId;
    private static volatile SelfHostedNotificationService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable reconnect = this::connect;
    private OkHttpClient client;
    private WebSocket socket;
    private NotificationEventTracker tracker;
    private int retry;
    private boolean stopping;
    private volatile String uiLanguage = "en";
    private int statusResource = R.string.notification_status_connecting;

    static void setAppVisible(boolean visible) {
        appVisible = visible;
        SelfHostedNotificationService current = instance;
        if (current != null) current.handler.post(current::handleVisibilityChange);
    }

    static void setActiveThread(Context context, String threadId) {
        activeThreadId = threadId;
        cancelEventNotifications(context, threadId);
    }

    static void releaseThread(String threadId) {
        if (threadId.equals(activeThreadId)) activeThreadId = null;
    }

    static boolean shouldNotifyEvent(boolean visible, String activeId, String eventThreadId) {
        return !visible || activeId == null || !activeId.equals(eventThreadId);
    }

    static void setUiLanguage(Context context, String language) {
        if (!"en".equals(language) && !"ru".equals(language)) return;
        context
            .getSharedPreferences(STATE_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(UI_LANGUAGE, language)
            .apply();
        SelfHostedNotificationService current = instance;
        if (current != null) current.handler.post(() -> current.applyUiLanguage(language));
    }

    static boolean observeFrame(String serializedFrame) {
        synchronized (OBSERVED_FRAMES_LOCK) {
            SelfHostedNotificationService current = instance;
            if (current != null && !current.stopping) {
                current.handler.post(() -> current.acceptObservedFrame(serializedFrame));
                return true;
            }
            pendingObservedFrames.addLast(serializedFrame);
            return false;
        }
    }

    static int eventNotificationId(CodexNotification.Kind kind, String threadId) {
        int requestCode = (kind.name() + ":" + threadId).hashCode();
        return 1_000 + Math.abs(requestCode % 1_000_000);
    }

    private static void cancelEventNotifications(Context context, String threadId) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        for (CodexNotification.Kind kind : CodexNotification.Kind.values()) {
            manager.cancel(eventNotificationId(kind, threadId));
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        uiLanguage = getSharedPreferences(STATE_PREFERENCES, Context.MODE_PRIVATE)
            .getString(UI_LANGUAGE, "en");
        createChannels();
        long lastObservedAt = getSharedPreferences(STATE_PREFERENCES, Context.MODE_PRIVATE)
            .getLong(LAST_OBSERVED_AT, 0);
        tracker = new NotificationEventTracker(
            lastObservedAt,
            text(R.string.notification_default_task),
            text(R.string.notification_open_details),
            text(R.string.notification_untitled_task)
        );
        client = new OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build();
        startAsForeground(statusNotification(statusResource));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopping = false;
        handler.removeCallbacks(reconnect);
        acceptPendingObservedFrames();
        handleVisibilityChange();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        if (instance == this) instance = null;
        handler.removeCallbacks(reconnect);
        WebSocket current = socket;
        socket = null;
        if (current != null) current.close(1000, "Service stopped");
        if (client != null) {
            client.dispatcher().executorService().shutdown();
            client.connectionPool().evictAll();
        }
        super.onDestroy();
    }

    private void connect() {
        if (stopping || appVisible) return;
        SecureConnectionSettings.Value settings = SecureConnectionSettings.read(this);
        if (settings == null) {
            updateStatus(R.string.notification_status_open_app);
            stopSelf();
            return;
        }

        WebSocket previous = socket;
        socket = null;
        if (previous != null) previous.cancel();
        HttpUrl base = HttpUrl.parse(settings.baseUrl);
        if (base == null) {
            scheduleReconnect();
            return;
        }
        HttpUrl webSocketUrl = base.newBuilder()
            .encodedPath(BuildConfig.EVENTS_PATH)
            .query(null)
            .fragment(null)
            .build();
        Request request = new Request.Builder()
            .url(webSocketUrl)
            .header("Origin", "http://localhost")
            .build();
        updateStatus(R.string.notification_status_connecting);
        socket = client.newWebSocket(request, new Listener(settings.token));
    }

    private void handleVisibilityChange() {
        handler.removeCallbacks(reconnect);
        if (appVisible) {
            WebSocket current = socket;
            socket = null;
            if (current != null) current.cancel();
            if (activeThreadId != null) cancelEventNotifications(this, activeThreadId);
            updateStatus(R.string.notification_status_app_open);
        } else {
            connect();
        }
    }

    private void scheduleReconnect() {
        if (stopping || appVisible) return;
        updateStatus(R.string.notification_status_reconnecting);
        long[] delays = { 1_000, 2_000, 4_000, 8_000, 15_000, 30_000 };
        long delay = delays[Math.min(retry, delays.length - 1)];
        retry += 1;
        handler.removeCallbacks(reconnect);
        handler.postDelayed(reconnect, delay);
    }

    private final class Listener extends WebSocketListener {

        private final String token;

        Listener(String token) {
            this.token = token;
        }

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            if (webSocket != socket) return;
            try {
                JSONObject authentication = new JSONObject();
                authentication.put("type", "authenticate");
                authentication.put("token", token);
                webSocket.send(authentication.toString());
                updateStatus(R.string.notification_status_authenticating);
            } catch (Exception error) {
                webSocket.close(1008, "Authentication failed");
            }
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            if (webSocket != socket) return;
            try {
                JSONObject frame = acceptFrame(text);
                if ("snapshot".equals(frame.optString("type"))) {
                    retry = 0;
                    updateStatus(R.string.notification_status_connected);
                }
            } catch (Exception ignored) {
                webSocket.close(1003, "Malformed frame");
            }
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (webSocket != socket) return;
            socket = null;
            scheduleReconnect();
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable error, Response response) {
            if (webSocket != socket) return;
            socket = null;
            scheduleReconnect();
        }
    }

    private void acceptObservedFrame(String serializedFrame) {
        try {
            acceptFrame(serializedFrame);
        } catch (Exception ignored) {
            // The WebView validates server frames before forwarding them.
        }
    }

    private void acceptPendingObservedFrames() {
        List<String> frames = new ArrayList<>();
        synchronized (OBSERVED_FRAMES_LOCK) {
            while (!pendingObservedFrames.isEmpty()) {
                frames.add(pendingObservedFrames.removeFirst());
            }
        }
        for (String frame : frames) acceptObservedFrame(frame);
    }

    private JSONObject acceptFrame(String serializedFrame) throws Exception {
        JSONObject frame = new JSONObject(serializedFrame);
        applyFrameLanguage(frame);
        List<CodexNotification> notifications = tracker.accept(serializedFrame);
        getSharedPreferences(STATE_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putLong(LAST_OBSERVED_AT, tracker.lastObservedAt())
            .apply();
        for (CodexNotification notification : notifications) notifyEvent(notification);
        return frame;
    }

    private void notifyEvent(CodexNotification event) {
        if (!shouldNotifyEvent(appVisible, activeThreadId, event.threadId)) {
            cancelEventNotifications(this, event.threadId);
            return;
        }
        String title;
        if (event.kind == CodexNotification.Kind.COMPLETED) {
            title = text(R.string.notification_task_completed);
        } else if (event.kind == CodexNotification.Kind.FAILED) {
            title = text(R.string.notification_task_failed);
        } else {
            title = text(R.string.notification_attention);
        }

        Intent intent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (event.threadId != null) intent.putExtra(MainActivity.EXTRA_THREAD_ID, event.threadId);
        int requestCode = (event.kind.name() + ":" + event.threadId).hashCode();
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification notification = new NotificationCompat.Builder(this, EVENT_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(event.threadTitle)
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build();
        notifyIfAllowed(eventNotificationId(event.kind, event.threadId), notification);
    }

    private Notification statusNotification(int status) {
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, SERVICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(text(R.string.app_name))
            .setContentText(text(status))
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void updateStatus(int status) {
        statusResource = status;
        notifyIfAllowed(SERVICE_NOTIFICATION_ID, statusNotification(status));
    }

    private void notifyIfAllowed(int notificationId, Notification notification) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
        ) {
            return;
        }
        try {
            NotificationManagerCompat.from(this).notify(notificationId, notification);
        } catch (SecurityException ignored) {
            // Permission can be revoked between the explicit check and notification delivery.
        }
    }

    private void startAsForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
            );
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification);
        }
    }

    private void createChannels() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel service = new NotificationChannel(
            SERVICE_CHANNEL,
            text(R.string.notification_channel_connection),
            NotificationManager.IMPORTANCE_LOW
        );
        service.setDescription(text(R.string.notification_channel_connection_description));
        service.setShowBadge(false);
        manager.createNotificationChannel(service);

        NotificationChannel events = new NotificationChannel(
            EVENT_CHANNEL,
            text(R.string.notification_channel_events),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        events.setDescription(text(R.string.notification_channel_events_description));
        manager.createNotificationChannel(events);
    }

    private void applyFrameLanguage(JSONObject frame) {
        String language = null;
        if ("snapshot".equals(frame.optString("type"))) {
            JSONObject snapshot = frame.optJSONObject("snapshot");
            if (snapshot != null) {
                language = snapshot.has("uiLanguage")
                    ? snapshot.optString("uiLanguage", null)
                    : "ru";
            }
        } else if ("event".equals(frame.optString("type"))) {
            JSONObject event = frame.optJSONObject("event");
            if (event != null && "uiLanguage.changed".equals(event.optString("type"))) {
                language = event.optString("language", null);
            }
        }
        if ("en".equals(language) || "ru".equals(language)) applyUiLanguage(language);
    }

    private void applyUiLanguage(String language) {
        if (!"en".equals(language) && !"ru".equals(language)) return;
        boolean changed = !language.equals(uiLanguage);
        uiLanguage = language;
        getSharedPreferences(STATE_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(UI_LANGUAGE, language)
            .apply();
        tracker.setFallbackTitles(
            text(R.string.notification_default_task),
            text(R.string.notification_open_details),
            text(R.string.notification_untitled_task)
        );
        if (changed) {
            createChannels();
            updateStatus(statusResource);
        }
    }

    private String text(int resourceId) {
        return LocalizedResources.getString(this, uiLanguage, resourceId);
    }
}
