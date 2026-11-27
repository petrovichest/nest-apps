package com.codexnest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import java.util.List;
import org.junit.Test;

public class NotificationEventTrackerTest {

    private static final String DIRECT_WORKER = "\"workerSession\":{\"name\":\"Reviewer\"}";
    private static final List<String> WORKER_METADATA = List.of(
        DIRECT_WORKER,
        "\"workerSession\":{\"name\":\"Reviewer\",\"delegated\":true}",
        "\"workerSession\":{\"name\":\"Reviewer\",\"parentThreadId\":\"delegated-parent\"}"
    );

    @Test
    public void recoveryNeverNotifiesAnErrorButActualFailureStillDoes() throws Exception {
        String[] recoveryStates = {
            "\"capacityRetry\":{\"failedTurnId\":\"failed\",\"nextAttemptAt\":300000}",
            "\"currentTurnId\":\"active-turn\"",
            "\"queuedMessageCount\":1"
        };
        for (String recovery : recoveryStates) {
            NotificationEventTracker tracker = new NotificationEventTracker(0);
            tracker.accept(snapshotFrame(notificationThread("running", 100, "")));
            assertEquals(0, tracker.accept(eventFrame(2, notificationThread("failed", 200, recovery))).size());
            assertEquals(0, tracker.accept(snapshotFrame(notificationThread("failed", 300, recovery))).size());
            List<CodexNotification> stopped = tracker.accept(eventFrame(4, notificationThread("failed", 400, "")));
            assertEquals(1, stopped.size());
            assertEquals(CodexNotification.Kind.FAILED, stopped.get(0).kind);
            assertEquals(0, tracker.accept(eventFrame(5, notificationThread("failed", 401, ""))).size());
        }
    }

    @Test
    public void reconnectAfterServiceRestartStaysSilentForCapacityRetry() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(100);
        assertEquals(0, tracker.accept(snapshotFrame(notificationThread("failed", 200,
            "\"capacityRetry\":{\"failedTurnId\":\"failed\",\"nextAttemptAt\":300000}"))).size());
        List<CodexNotification> stopped = tracker.accept(eventFrame(3, notificationThread("failed", 300, "")));
        assertEquals(1, stopped.size());
        assertEquals(CodexNotification.Kind.FAILED, stopped.get(0).kind);
    }

    @Test
    public void completionOnlyNotifiesOnceAutomaticWorkHasStopped() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(snapshotFrame(notificationThread("running", 100, "")));
        assertEquals(0, tracker.accept(eventFrame(2, notificationThread("completed", 200,
            "\"capacityRetry\":{\"failedTurnId\":\"failed\",\"nextAttemptAt\":300000}"))).size());
        List<CodexNotification> done = tracker.accept(eventFrame(3, notificationThread("completed", 300, "")));
        assertEquals(1, done.size());
        assertEquals(CodexNotification.Kind.COMPLETED, done.get(0).kind);
    }

    private static String notificationThread(String state, long updatedAt, String extra) {
        return "{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"" + state + "\",\"unread\":true,\"updatedAt\":" + updatedAt + (extra.isEmpty() ? "" : "," + extra) + "}";
    }

    private static String snapshotFrame(String thread) {
        return snapshotFrame(thread, "");
    }

    private static String snapshotFrame(String thread, String attention) {
        return "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[" + thread
            + "],\"attention\":[" + attention + "]}}";
    }

    private static String eventFrame(long sequence, String thread) {
        return "{\"type\":\"event\",\"sequence\":" + sequence + ",\"event\":{\"type\":\"thread.upserted\",\"thread\":" + thread + "}}";
    }

    @Test
    public void initialSnapshotDoesNotNotifyForOldThreads() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        List<CodexNotification> notifications = tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Old\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":200}],\"attention\":[]}}"
        );
        assertEquals(0, notifications.size());
        assertEquals(200, tracker.lastObservedAt());
    }

    @Test
    public void terminalTransitionNotifiesOnce() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );
        List<CodexNotification> first = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"completed\",\"updatedAt\":200}}}"
        );
        List<CodexNotification> duplicate = tracker.accept(
            "{\"type\":\"event\",\"sequence\":3,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"completed\",\"updatedAt\":201}}}"
        );
        assertEquals(1, first.size());
        assertEquals(CodexNotification.Kind.COMPLETED, first.get(0).kind);
        assertEquals(0, duplicate.size());
    }

    @Test
    public void needsAttentionTransitionNotifiesOnce() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );
        List<CodexNotification> first = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"needsAttention\",\"updatedAt\":200}}}"
        );
        List<CodexNotification> duplicate = tracker.accept(
            "{\"type\":\"event\",\"sequence\":3,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"needsAttention\",\"updatedAt\":201}}}"
        );
        assertEquals(1, first.size());
        assertEquals(CodexNotification.Kind.ATTENTION, first.get(0).kind);
        assertEquals(0, duplicate.size());
    }

    @Test
    public void outgoingQueuedMessageDoesNotLookLikeACompletedTurn() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"sequence\":1,\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100,\"queuedMessageCount\":0}],\"attention\":[]}}"
        );

        List<CodexNotification> queued = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":200,\"queuedMessageCount\":1}}}"
        );
        tracker.accept(
            "{\"type\":\"event\",\"sequence\":3,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":201,\"queuedMessageCount\":0}}}"
        );
        List<CodexNotification> completed = tracker.accept(
            "{\"type\":\"event\",\"sequence\":4,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":300,\"queuedMessageCount\":0}}}"
        );

        assertEquals(0, queued.size());
        assertEquals(1, completed.size());
        assertEquals(CodexNotification.Kind.COMPLETED, completed.get(0).kind);
    }

    @Test
    public void staleDuplicateStreamEventCannotRestoreATerminalState() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"sequence\":10,\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":100,\"queuedMessageCount\":0}],\"attention\":[]}}"
        );
        tracker.accept(
            "{\"type\":\"event\",\"sequence\":12,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":200,\"queuedMessageCount\":0}}}"
        );

        List<CodexNotification> stale = tracker.accept(
            "{\"type\":\"event\",\"sequence\":11,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":150,\"queuedMessageCount\":0}}}"
        );

        assertEquals(0, stale.size());
        assertEquals(200, tracker.lastObservedAt());
    }

    @Test
    public void explicitAttentionDoesNotDuplicateNeedsAttentionState() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );
        List<CodexNotification> request = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"attention.upserted\",\"attention\":{\"id\":\"attention-1\",\"threadId\":\"one\",\"createdAt\":200}}}"
        );
        List<CodexNotification> state = tracker.accept(
            "{\"type\":\"event\",\"sequence\":3,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"needsAttention\",\"updatedAt\":201}}}"
        );
        assertEquals(1, request.size());
        assertEquals(0, state.size());
    }

    @Test
    public void reconnectSnapshotDeliversMissedUnreadOutcomeAndAttention() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(100);
        List<CodexNotification> notifications = tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"failed\",\"unread\":true,\"updatedAt\":200}],\"attention\":[{\"id\":\"attention-1\",\"threadId\":\"one\",\"createdAt\":210}]}}"
        );
        assertEquals(2, notifications.size());
        assertEquals(CodexNotification.Kind.FAILED, notifications.get(0).kind);
        assertEquals(CodexNotification.Kind.ATTENTION, notifications.get(1).kind);
        assertEquals(210, tracker.lastObservedAt());
    }

    @Test
    public void reconnectSnapshotDeliversMissedNeedsAttentionState() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(100);
        List<CodexNotification> notifications = tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"needsAttention\",\"unread\":false,\"updatedAt\":200}],\"attention\":[]}}"
        );
        assertEquals(1, notifications.size());
        assertEquals(CodexNotification.Kind.ATTENTION, notifications.get(0).kind);
    }

    @Test
    public void asyncQuestionsOnlyNotifyOnceUntilAttentionClearsIncludingReconnect() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(snapshotFrame(notificationThread("running", 100, "\"currentTurnId\":\"turn\"")));
        List<CodexNotification> first = tracker.accept(eventFrame(2,
            notificationThread("needsAttention", 200, "\"currentTurnId\":\"turn\"")));
        assertEquals(1, first.size());
        assertEquals(CodexNotification.Kind.ATTENTION, first.get(0).kind);
        assertEquals(0, tracker.accept(eventFrame(3,
            notificationThread("needsAttention", 210, "\"currentTurnId\":\"turn\""))).size());
        assertEquals(0, tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"sequence\":4,\"threads\":[" +
            notificationThread("needsAttention", 300, "\"currentTurnId\":\"turn\"") +
            "],\"attention\":[{\"id\":\"attention-1\",\"threadId\":\"one\",\"createdAt\":310}]}}"
        ).size());
        tracker.accept("{\"type\":\"event\",\"sequence\":5,\"event\":{\"type\":\"attention.removed\",\"attentionId\":\"attention-1\"}}");
        tracker.accept(eventFrame(6, notificationThread("running", 400, "\"currentTurnId\":\"turn\"")));
        assertEquals(1, tracker.accept(eventFrame(7,
            notificationThread("needsAttention", 500, "\"currentTurnId\":\"turn\""))).size());
    }

    @Test
    public void reconnectDetectsAttentionEvenWhenTheTimestampHasNotAdvanced() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(snapshotFrame(notificationThread("running", 100, "")));
        List<CodexNotification> missed = tracker.accept(snapshotFrame(
            notificationThread("needsAttention", 100, "\"currentTurnId\":\"turn\"")));
        assertEquals(1, missed.size());
        assertEquals(CodexNotification.Kind.ATTENTION, missed.get(0).kind);
    }

    @Test
    public void reconnectCombinesMissedAttentionRequestsForOneSession() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(100);
        List<CodexNotification> missed = tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[" +
            notificationThread("needsAttention", 200, "\"currentTurnId\":\"turn\"") +
            "],\"attention\":[{\"id\":\"attention-1\",\"threadId\":\"one\",\"createdAt\":210}," +
            "{\"id\":\"attention-2\",\"threadId\":\"one\",\"createdAt\":220}]}}"
        );
        assertEquals(1, missed.size());
        assertEquals(CodexNotification.Kind.ATTENTION, missed.get(0).kind);
    }

    @Test
    public void observedForegroundOutcomeDoesNotNotifyAgainAfterBackgroundReconnect()
        throws Exception {
        NotificationEventTracker foreground = new NotificationEventTracker(0);
        foreground.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );
        List<CodexNotification> immediate = foreground.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":200}}}"
        );

        NotificationEventTracker background = new NotificationEventTracker(
            foreground.lastObservedAt()
        );
        List<CodexNotification> reconnect = background.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Task\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":200}],\"attention\":[]}}"
        );

        assertEquals(1, immediate.size());
        assertEquals(0, reconnect.size());
    }

    @Test
    public void childSessionsNeverNotifyFromLiveEventsOrReconnectSnapshots() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"sequence\":1,\"threads\":[{\"id\":\"child\",\"relation\":{\"kind\":\"subagent\",\"sessionId\":\"child-session\",\"parentThreadId\":\"parent\"},\"title\":\"Child\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );

        List<CodexNotification> completed = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"child\",\"relation\":{\"kind\":\"subagent\",\"sessionId\":\"child-session\",\"parentThreadId\":\"parent\"},\"title\":\"Child\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":200}}}"
        );
        List<CodexNotification> attention = tracker.accept(
            "{\"type\":\"event\",\"sequence\":3,\"event\":{\"type\":\"attention.upserted\",\"attention\":{\"id\":\"attention-child\",\"threadId\":\"child\",\"createdAt\":210}}}"
        );
        List<CodexNotification> needsAttention = tracker.accept(
            "{\"type\":\"event\",\"sequence\":4,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"child\",\"relation\":{\"kind\":\"subagent\",\"sessionId\":\"child-session\",\"parentThreadId\":\"parent\"},\"title\":\"Child\",\"state\":\"needsAttention\",\"unread\":false,\"updatedAt\":220}}}"
        );
        List<CodexNotification> reconnect = tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"sequence\":5,\"threads\":[{\"id\":\"child\",\"relation\":{\"kind\":\"subagent\",\"sessionId\":\"child-session\",\"parentThreadId\":\"parent\"},\"title\":\"Child\",\"state\":\"failed\",\"unread\":true,\"updatedAt\":300}],\"attention\":[{\"id\":\"attention-reconnect\",\"threadId\":\"child\",\"createdAt\":310}]}}"
        );

        assertEquals(0, completed.size());
        assertEquals(0, attention.size());
        assertEquals(0, needsAttention.size());
        assertEquals(0, reconnect.size());
        assertEquals(310, tracker.lastObservedAt());
    }

    @Test
    public void onlyDirectWorkersNotifyFromLiveEvents() throws Exception {
        String attention = """
            {"id":"attention-1","threadId":"one","createdAt":200}
            """;
        for (String worker : WORKER_METADATA) {
            NotificationEventTracker tracker = new NotificationEventTracker(0);
            tracker.accept(snapshotFrame(notificationThread("running", 100, worker)));
            assertWorkerNotification(worker, CodexNotification.Kind.ATTENTION, tracker.accept(
                """
                {"type":"event","sequence":2,"event":{"type":"attention.upserted","attention":%s}}
                """.formatted(attention)
            ));
            tracker.accept("""
                {"type":"event","sequence":3,"event":{"type":"attention.removed","attentionId":"attention-1"}}
                """);
            assertWorkerNotification(worker, CodexNotification.Kind.COMPLETED, tracker.accept(
                eventFrame(4, notificationThread("completed", 300, worker))
            ));
            assertWorkerNotification(worker, CodexNotification.Kind.FAILED, tracker.accept(
                eventFrame(5, notificationThread("failed", 400, worker))
            ));
            assertWorkerNotification(worker, CodexNotification.Kind.ATTENTION, tracker.accept(
                eventFrame(6, notificationThread("needsAttention", 500, worker))
            ));
            assertEquals(500, tracker.lastObservedAt());
        }
    }

    @Test
    public void onlyDirectWorkersNotifyFromRestoredSnapshots() throws Exception {
        for (String worker : WORKER_METADATA) {
            assertWorkerNotification(worker, CodexNotification.Kind.COMPLETED,
                new NotificationEventTracker(100).accept(
                    snapshotFrame(notificationThread("completed", 200, worker))
                )
            );
            assertWorkerNotification(worker, CodexNotification.Kind.FAILED,
                new NotificationEventTracker(100).accept(
                    snapshotFrame(notificationThread("failed", 200, worker))
                )
            );
            assertWorkerNotification(worker, CodexNotification.Kind.ATTENTION,
                new NotificationEventTracker(100).accept(
                    snapshotFrame(notificationThread("needsAttention", 200, worker))
                )
            );
            NotificationEventTracker restored = new NotificationEventTracker(100);
            assertWorkerNotification(worker, CodexNotification.Kind.ATTENTION, restored.accept(
                snapshotFrame(
                    notificationThread("running", 200, worker),
                    "{\"id\":\"attention-1\",\"threadId\":\"one\",\"createdAt\":210}"
                )
            ));
            assertEquals(210, restored.lastObservedAt());
        }
    }

    private static void assertWorkerNotification(
        String worker,
        CodexNotification.Kind kind,
        List<CodexNotification> notifications
    ) {
        boolean direct = DIRECT_WORKER.equals(worker);
        assertEquals(kind + " for " + worker, direct ? 1 : 0, notifications.size());
        if (direct) {
            assertEquals(kind, notifications.get(0).kind);
            assertEquals("one", notifications.get(0).threadId);
            assertEquals("Task", notifications.get(0).threadTitle);
        }
    }

    @Test
    public void notificationIdsAreStableAndDistinctByKindAndThread() {
        int completed = SelfHostedNotificationService.eventNotificationId(
            CodexNotification.Kind.COMPLETED,
            "one"
        );

        assertEquals(
            completed,
            SelfHostedNotificationService.eventNotificationId(
                CodexNotification.Kind.COMPLETED,
                "one"
            )
        );
        assertNotEquals(
            completed,
            SelfHostedNotificationService.eventNotificationId(
                CodexNotification.Kind.FAILED,
                "one"
            )
        );
        assertNotEquals(
            completed,
            SelfHostedNotificationService.eventNotificationId(
                CodexNotification.Kind.COMPLETED,
                "two"
            )
        );
    }

    @Test
    public void localizesTheServerFallbackThreadTitle() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(
            0,
            "Codex task",
            "Open CodexNest for details",
            "Untitled"
        );
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Без названия\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );
        List<CodexNotification> notifications = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"relation\":{\"kind\":\"session\",\"sessionId\":\"session\"},\"title\":\"Без названия\",\"state\":\"completed\",\"updatedAt\":200}}}"
        );

        assertEquals("Untitled", notifications.get(0).threadTitle);
    }
}
