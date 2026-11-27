package com.codexnest.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

final class NotificationEventTracker {

    private final Map<String, String> threadStates = new HashMap<>();
    private final Map<String, String> threadTitles = new HashMap<>();
    private final Set<String> notifiableThreadIds = new HashSet<>();
    private final Map<String, String> attentionThreads = new HashMap<>();
    private long lastObservedAt;
    private long lastSequence = -1;
    private String defaultThreadTitle;
    private String detailsTitle;
    private String untitledThreadTitle;

    NotificationEventTracker(long lastObservedAt) {
        this(lastObservedAt, "Codex task", "Open CodexNest for details", "Untitled");
    }

    NotificationEventTracker(
        long lastObservedAt,
        String defaultThreadTitle,
        String detailsTitle,
        String untitledThreadTitle
    ) {
        this.lastObservedAt = lastObservedAt;
        this.defaultThreadTitle = defaultThreadTitle;
        this.detailsTitle = detailsTitle;
        this.untitledThreadTitle = untitledThreadTitle;
    }

    synchronized void setFallbackTitles(
        String defaultThreadTitle,
        String detailsTitle,
        String untitledThreadTitle
    ) {
        this.defaultThreadTitle = defaultThreadTitle;
        this.detailsTitle = detailsTitle;
        this.untitledThreadTitle = untitledThreadTitle;
    }

    synchronized List<CodexNotification> accept(String serializedFrame) throws Exception {
        List<CodexNotification> notifications = new ArrayList<>();
        JSONObject frame = new JSONObject(serializedFrame);
        String type = frame.optString("type");
        if ("snapshot".equals(type)) {
            JSONObject snapshot = frame.getJSONObject("snapshot");
            lastSequence = snapshot.optLong("sequence", -1);
            acceptSnapshot(snapshot, notifications);
        } else if ("event".equals(type)) {
            long sequence = frame.optLong("sequence", -1);
            if (sequence >= 0 && lastSequence >= 0 && sequence <= lastSequence) {
                return notifications;
            }
            acceptEvent(frame.getJSONObject("event"), notifications);
            if (sequence >= 0) lastSequence = sequence;
        }
        return notifications;
    }

    synchronized long lastObservedAt() {
        return lastObservedAt;
    }

    private void acceptSnapshot(JSONObject snapshot, List<CodexNotification> notifications) {
        long cutoff = lastObservedAt;
        boolean firstConnection = cutoff == 0;
        Map<String, String> previousThreadStates = new HashMap<>(threadStates);
        long newest = cutoff;
        threadStates.clear();
        threadTitles.clear();
        notifiableThreadIds.clear();
        attentionThreads.clear();
        List<JSONObject> missedThreads = new ArrayList<>();
        List<CodexNotification> missedAttention = new ArrayList<>();
        Set<String> missedAttentionThreads = new HashSet<>();

        JSONArray threads = snapshot.optJSONArray("threads");
        if (threads != null) {
            for (int index = 0; index < threads.length(); index += 1) {
                JSONObject thread = threads.optJSONObject(index);
                if (thread == null) continue;
                String id = thread.optString("id");
                String state = notificationState(thread);
                String title = thread.optString("title", defaultThreadTitle);
                long updatedAt = thread.optLong("updatedAt", 0);
                threadStates.put(id, state);
                threadTitles.put(id, title);
                if (isNotifiableThread(thread)) notifiableThreadIds.add(id);
                newest = Math.max(newest, updatedAt);
                if (
                    !firstConnection &&
                    notifiableThreadIds.contains(id) &&
                    (updatedAt > cutoff ||
                        ("needsAttention".equals(state) && previousThreadStates.containsKey(id))) &&
                    (thread.optBoolean("unread", false) || "needsAttention".equals(state)) &&
                    (!"needsAttention".equals(state) ||
                        !"needsAttention".equals(previousThreadStates.get(id)))
                ) {
                    missedThreads.add(thread);
                }
            }
        }

        JSONArray attention = snapshot.optJSONArray("attention");
        if (attention != null) {
            for (int index = 0; index < attention.length(); index += 1) {
                JSONObject request = attention.optJSONObject(index);
                if (request == null) continue;
                String id = request.optString("id");
                String threadId = nullableString(request, "threadId");
                attentionThreads.put(id, threadId);
                long createdAt = request.optLong("createdAt", 0);
                newest = Math.max(newest, createdAt);
                if (
                    !firstConnection &&
                    threadId != null &&
                    notifiableThreadIds.contains(threadId) &&
                    createdAt > cutoff &&
                    !"needsAttention".equals(previousThreadStates.get(threadId)) &&
                    missedAttentionThreads.add(threadId)
                ) {
                    missedAttention.add(
                        new CodexNotification(
                            CodexNotification.Kind.ATTENTION,
                            threadId,
                            titleFor(threadId)
                        )
                    );
                }
            }
        }
        for (JSONObject thread : missedThreads) {
            addStateNotification(notifications, thread);
        }
        notifications.addAll(missedAttention);
        lastObservedAt = newest;
    }

    private void acceptEvent(JSONObject event, List<CodexNotification> notifications)
        throws Exception {
        String type = event.optString("type");
        if ("thread.upserted".equals(type)) {
            JSONObject thread = event.getJSONObject("thread");
            String id = thread.optString("id");
            String state = notificationState(thread);
            String title = thread.optString("title", defaultThreadTitle);
            String previous = threadStates.put(id, state);
            threadTitles.put(id, title);
            if (isNotifiableThread(thread)) {
                notifiableThreadIds.add(id);
            } else {
                notifiableThreadIds.remove(id);
            }
            if (!state.equals(previous)) {
                addStateNotification(notifications, thread);
            }
            lastObservedAt = Math.max(lastObservedAt, thread.optLong("updatedAt", 0));
        } else if ("thread.removed".equals(type)) {
            String id = event.optString("threadId");
            threadStates.remove(id);
            threadTitles.remove(id);
            notifiableThreadIds.remove(id);
        } else if ("attention.upserted".equals(type)) {
            JSONObject request = event.getJSONObject("attention");
            String id = request.optString("id");
            if (!attentionThreads.containsKey(id)) {
                String threadId = nullableString(request, "threadId");
                attentionThreads.put(id, threadId);
                if (
                    threadId != null &&
                    notifiableThreadIds.contains(threadId) &&
                    !"needsAttention".equals(threadStates.get(threadId))
                ) {
                    notifications.add(
                        new CodexNotification(
                            CodexNotification.Kind.ATTENTION,
                            threadId,
                            titleFor(threadId)
                        )
                    );
                }
            }
            lastObservedAt = Math.max(lastObservedAt, request.optLong("createdAt", 0));
        } else if ("attention.removed".equals(type)) {
            attentionThreads.remove(event.optString("attentionId"));
        }
    }

    private void addStateNotification(
        List<CodexNotification> notifications,
        JSONObject thread
    ) {
        String state = notificationState(thread);
        String threadId = thread.optString("id");
        String title = thread.optString("title", defaultThreadTitle);
        if (!notifiableThreadIds.contains(threadId)) return;
        if ("completed".equals(state)) {
            notifications.add(
                new CodexNotification(
                    CodexNotification.Kind.COMPLETED,
                    threadId,
                    displayTitle(title)
                )
            );
        } else if ("failed".equals(state)) {
            notifications.add(
                new CodexNotification(CodexNotification.Kind.FAILED, threadId, displayTitle(title))
            );
        } else if ("needsAttention".equals(state) && !attentionThreads.containsValue(threadId)) {
            notifications.add(
                new CodexNotification(
                    CodexNotification.Kind.ATTENTION,
                    threadId,
                    displayTitle(title)
                )
            );
        }
    }

    private String titleFor(String threadId) {
        if (threadId == null) return detailsTitle;
        return displayTitle(threadTitles.getOrDefault(threadId, defaultThreadTitle));
    }

    private String displayTitle(String title) {
        return "Без названия".equals(title) || "Untitled".equals(title)
            ? untitledThreadTitle
            : title;
    }

    private static boolean isNotifiableThread(JSONObject thread) {
        JSONObject relation = thread.optJSONObject("relation");
        if (relation == null || !"session".equals(relation.optString("kind"))) return false;
        JSONObject worker = thread.optJSONObject("workerSession");
        if (worker == null) return true;
        String parentThreadId = nullableString(worker, "parentThreadId");
        return !Boolean.TRUE.equals(worker.opt("delegated")) &&
            (parentThreadId == null || parentThreadId.isEmpty());
    }

    private static String notificationState(JSONObject thread) {
        String state = thread.optString("state");
        if (
            ("completed".equals(state) || "failed".equals(state)) &&
            (nullableString(thread, "currentTurnId") != null ||
                thread.optJSONObject("capacityRetry") != null ||
                thread.optInt("queuedMessageCount", 0) > 0)
        ) return "running";
        return state;
    }

    private static String nullableString(JSONObject object, String key) {
        return object.isNull(key) ? null : object.optString(key, null);
    }
}
