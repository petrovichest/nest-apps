package com.codexnest.app;

import static org.junit.Assert.assertEquals;

import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ClaudeNotificationEventTrackerTest {

    private static final String THREAD_ID = "f07b9783-f119-42a6-955b-aecf01b7a21f";
    private static final String INSTANCE_ID = "fe30f8d1-08bc-46bb-b9bc-8cc8536a4a4e";

    private static JSONObject thread(String state, long updatedAt) throws Exception {
        return new JSONObject()
            .put("id", THREAD_ID)
            .put("title", "Claude session")
            .put("state", state)
            .put("unread", !"running".equals(state))
            .put("updatedAt", updatedAt)
            .put("currentTurnId", "running".equals(state) ? "claude-turn" : JSONObject.NULL)
            .put("queuedMessageCount", 0)
            .put("relation", new JSONObject().put("kind", "session").put("sessionId", THREAD_ID));
    }

    private static JSONObject version(long sequence) throws Exception {
        return new JSONObject().put("instanceId", INSTANCE_ID).put("sequence", sequence);
    }

    private static String snapshot(long sequence, JSONObject thread, JSONArray attention)
        throws Exception {
        return new JSONObject()
            .put("type", "snapshot")
            .put("snapshot", new JSONObject()
                .put("provider", "claude")
                .put("sequence", sequence)
                .put("version", version(sequence))
                .put("threads", new JSONArray().put(thread))
                .put("attention", attention))
            .toString();
    }

    private static String event(long sequence, String type, String key, JSONObject value)
        throws Exception {
        return new JSONObject()
            .put("type", "event")
            .put("sequence", sequence)
            .put("version", version(sequence))
            .put("event", new JSONObject().put("type", type).put(key, value))
            .toString();
    }

    @Test
    public void claudeTerminalEventsNotifyOnceAndPreserveSessionRouting() throws Exception {
        for (String state : new String[] { "completed", "failed" }) {
            NotificationEventTracker tracker = new NotificationEventTracker(
                0, "Claude task", "Open ClaudeNest for details", "Untitled"
            );
            assertEquals(0, tracker.accept(snapshot(1, thread("running", 100), new JSONArray())).size());
            String terminal = event(2, "thread.upserted", "thread", thread(state, 200));
            List<CodexNotification> notifications = tracker.accept(terminal);
            assertEquals(1, notifications.size());
            assertEquals(
                "completed".equals(state) ? CodexNotification.Kind.COMPLETED : CodexNotification.Kind.FAILED,
                notifications.get(0).kind
            );
            assertEquals(THREAD_ID, notifications.get(0).threadId);
            assertEquals("Claude session", notifications.get(0).threadTitle);
            assertEquals(0, tracker.accept(terminal).size());
            assertEquals(0, tracker.accept(event(3, "thread.upserted", "thread", thread(state, 201))).size());
        }
    }

    @Test
    public void claudePermissionRequestDoesNotDuplicateItsThreadStateEvent() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(snapshot(1, thread("running", 100), new JSONArray()));
        JSONObject request = new JSONObject()
            .put("id", "claude-permission-request")
            .put("threadId", THREAD_ID)
            .put("createdAt", 200);
        List<CodexNotification> notifications = tracker.accept(
            event(2, "attention.upserted", "attention", request)
        );
        assertEquals(1, notifications.size());
        assertEquals(CodexNotification.Kind.ATTENTION, notifications.get(0).kind);
        assertEquals(THREAD_ID, notifications.get(0).threadId);
        assertEquals(0, tracker.accept(event(3, "thread.upserted", "thread", thread("needsAttention", 201))).size());
        assertEquals(0, tracker.accept(event(4, "attention.upserted", "attention", request)).size());
    }

    @Test
    public void claudeReconnectRecoversMissedOutcomeWhileFirstConnectionStaysSilent()
        throws Exception {
        String missed = snapshot(5, thread("completed", 200), new JSONArray());
        assertEquals(0, new NotificationEventTracker(0).accept(missed).size());
        NotificationEventTracker restored = new NotificationEventTracker(100);
        List<CodexNotification> notifications = restored.accept(missed);
        assertEquals(1, notifications.size());
        assertEquals(CodexNotification.Kind.COMPLETED, notifications.get(0).kind);
        assertEquals(THREAD_ID, notifications.get(0).threadId);
        assertEquals(0, restored.accept(missed).size());
    }

    @Test
    public void claudeReconnectCombinesPendingPermissionRequestsForOneSession()
        throws Exception {
        JSONArray requests = new JSONArray()
            .put(new JSONObject().put("id", "first").put("threadId", THREAD_ID).put("createdAt", 210))
            .put(new JSONObject().put("id", "second").put("threadId", THREAD_ID).put("createdAt", 220));
        NotificationEventTracker restored = new NotificationEventTracker(100);
        List<CodexNotification> notifications = restored.accept(
            snapshot(5, thread("needsAttention", 200), requests)
        );
        assertEquals(1, notifications.size());
        assertEquals(CodexNotification.Kind.ATTENTION, notifications.get(0).kind);
        assertEquals(220, restored.lastObservedAt());
    }
}
