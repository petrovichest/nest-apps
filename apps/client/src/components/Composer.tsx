import { onBeforeAppReload } from "../app-reload";
import { application } from "../application";
import { useTypography } from "../typography";
import type { PendingAnnotation } from "../annotations";
import { pastedText, samePastedText, type PastedText } from "@codexnest/protocol";
import { AnnotationBubbles } from "./AnnotationBubbles";
import { PasteBlocks } from "./PasteBlocks";
import { PasteTextarea, usePasteEditor } from "./PasteEditor";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  ModelOption,
  Project,
  SessionSettings,
  SkillCatalogItem,
  ThreadGoal,
  ThreadFileAttachment,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  UpdateThreadGoalRequest,
  UpdateThreadSettingsRequest,
  VoiceTranscriptionStatus,
} from "@codexnest/protocol";

import { localizeKnownServerText, type Translate, useI18n } from "../i18n";
import { useSkillsCatalog } from "../useSkillsCatalog";
import {
  ChevronDownIcon,
  ClipboardIcon,
  FileIcon,
  ImageIcon,
  MicrophoneIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
  XIcon,
} from "./Icons";
import { ImageViewer } from "./ImageViewer";
import { SettingsPicker } from "./SettingsPicker";
import {
  formatRecordingTime,
  formatTimerSeconds,
  formatTranscriptionTimer,
  insertTranscriptAtSelection,
  microphoneUnavailableReason,
  recordingErrorMessage,
  recordingMimeType,
} from "./speech-input";

export type ComposerImage = {
  id: string;
  name: string;
  url: string;
};

export type ComposerRecording = {
  id: string;
  audio: Blob;
  durationMs: number;
  selection: { start: number; end: number };
};

export type ComposerTranscriptionStatus = {
  elapsedSeconds: number;
  estimatedTotalSeconds: number | null;
  status?: "uploading" | Exclude<VoiceTranscriptionStatus, "failed">;
};

export type ComposerSubmitIntent = "queue" | "immediate";

const KEYBOARD_VIEWPORT_DELTA = 120;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENT_BYTES = 250 * 1024 * 1024;

type SpeechState = "idle" | "requesting" | "recording" | "uploading" | "transcribing";

type RecordingCapture = {
  id: string;
  sessionIdentity: string | undefined;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  selection: { start: number; end: number };
  maxUploadBytes: number;
  discarded: boolean;
  preserveOnSessionChange: boolean;
  submit?: (recording: ComposerRecording) => Promise<void>;
  transcribe?: (audio: Blob, durationMs: number) => Promise<string>;
};

function viewportHeight(): number {
  return Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight);
}

function createVoiceRecordingId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function Composer({
  input,
  pastes = {},
  onInput,
  onDraftFlush,
  onLayoutChange,
  images,
  onImagesChange,
  files = [],
  onFilesChange,
  onUploadFiles,
  onDeleteFile,
  annotations = [],
  onOpenAnnotation,
  onDeleteAnnotation,
  attachmentScope = 0,
  onPendingAttachmentsChange,
  onSubmit,
  onSendQueuedNow,
  busy,
  inputUnavailable = false,
  codexSettings,
  running = false,
  settings,
  onSettingsChange,
  settingsBusy = false,
  settingsDisabled = false,
  effortDisabled = false,
  goalMode = false,
  goal,
  goalBusy = false,
  onGoalModeChange,
  onGoalUpdate,
  onGoalClear,
  models,
  projects,
  projectId,
  cwd = null,
  skillsEpoch = 0,
  onProjectChange,
  onNewProject,
  onStop,
  transcriptionConfig = null,
  transcriptionProvider = null,
  onTranscribe,
  onRecordingReady,
  preserveRecordingOnSessionChange = false,
  voiceUploadPending = false,
  voiceInputLocked = false,
  onCancelVoiceTranscription,
  voiceCancellationPending = false,
  transcriptionStatus = null,
  transcriptionError = null,
  onDismissTranscriptionError,
  error,
  autoFocus = false,
  initialSelection,
  sessionIdentity,
  inputSyncRevision = 0,
  hasSupplementalContent = false,
  children,
}: {
  input: string;
  pastes?: PastedText;
  onInput(value: string, pastes?: PastedText): void;
  onDraftFlush?(): void;
  onLayoutChange?(): void;
  images: ComposerImage[];
  onImagesChange(value: ComposerImage[], attachmentScope?: number): void;
  files?: ThreadFileAttachment[];
  onFilesChange?(value: ThreadFileAttachment[], attachmentScope?: number): void;
  onUploadFiles?(files: readonly File[], attachmentScope?: number): Promise<ThreadFileAttachment[]>;
  onDeleteFile?(file: ThreadFileAttachment): Promise<void>;
  annotations?: PendingAnnotation[];
  onOpenAnnotation?(annotationId: string): void;
  onDeleteAnnotation?(annotationId: string): void;
  attachmentScope?: number;
  onPendingAttachmentsChange?(pending: boolean, attachmentScope?: number): void;
  onSubmit(intent: ComposerSubmitIntent): void;
  onSendQueuedNow?(): void;
  busy: boolean;
  inputUnavailable?: boolean;
  codexSettings?: { model: string | null; reasoningEffort: string | null };
  running?: boolean;
  settings: SessionSettings;
  onSettingsChange(value: UpdateThreadSettingsRequest): void;
  settingsBusy?: boolean;
  settingsDisabled?: boolean;
  effortDisabled?: boolean;
  goalMode?: boolean;
  goal?: ThreadGoal | null;
  goalBusy?: boolean;
  onGoalModeChange?(value: boolean): void;
  onGoalUpdate?(value: UpdateThreadGoalRequest): void;
  onGoalClear?(): void;
  models: ModelOption[];
  projects?: Project[];
  projectId?: string;
  cwd?: string | null;
  skillsEpoch?: number;
  onProjectChange?(projectId: string): void;
  onNewProject?(): void;
  onStop?(): void;
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onTranscribe?(audio: Blob, durationMs: number): Promise<string>;
  onRecordingReady?(recording: ComposerRecording): Promise<void>;
  preserveRecordingOnSessionChange?: boolean;
  voiceUploadPending?: boolean;
  voiceInputLocked?: boolean;
  onCancelVoiceTranscription?(): void;
  voiceCancellationPending?: boolean;
  transcriptionStatus?: ComposerTranscriptionStatus | null;
  transcriptionError?: string | null;
  onDismissTranscriptionError?(): void;
  error: string | null;
  autoFocus?: boolean;
  initialSelection?: { start: number; end: number } | null;
  sessionIdentity?: string;
  inputSyncRevision?: number;
  hasSupplementalContent?: boolean;
  children?: ReactNode;
}) {
  const { language, t } = useI18n();
  const { message: messageFontSize } = useTypography();
  const creating = projects !== undefined;
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draftInput, setDraftInput] = useState(input);
  const draftInputRef = useRef(input);
  const [draftPastes, setDraftPastes] = useState<PastedText>(() => pastedText(pastes));
  const draftPastesRef = useRef(draftPastes);
  const cardsId = useId();
  const cardsRef = useRef<HTMLDivElement>(null);
  const [cardsExpanded, setCardsExpanded] = useState(false);
  const cardCount =
    images.length + files.length + annotations.length + (draftPastes.pasteBlocks?.length ?? 0);
  const cardsHidden = cardCount > 2 && !cardsExpanded;
  const pluralRules = useMemo(() => new Intl.PluralRules(language), [language]);
  const cardCounts: [number, string, string, string, typeof FileIcon][] = [
    [
      annotations.length,
      "{{count}} аннотация",
      "{{count}} аннотации",
      "{{count}} аннотаций",
      PencilIcon,
    ],
    [
      images.length,
      "{{count}} изображение",
      "{{count}} изображения",
      "{{count}} изображений",
      ImageIcon,
    ],
    [files.length, "{{count}} файл", "{{count}} файла", "{{count}} файлов", FileIcon],
    [
      draftPastes.pasteBlocks?.length ?? 0,
      "{{count}} вставка",
      "{{count}} вставки",
      "{{count}} вставок",
      ClipboardIcon,
    ],
  ];
  const cardTypes = cardCounts
    .filter(([count]) => count > 0)
    .map(([count, one, few, many, Icon]) => {
      const plural = pluralRules.select(count);
      return {
        count,
        Icon,
        label: t(plural === "one" ? one : plural === "few" ? few : many, { count }),
      };
    });
  const cardSummary = cardTypes.map(({ label }) => label).join(" · ");

  useEffect(() => {
    if (cardCount === 0) setCardsExpanded(false);
  }, [cardCount]);

  useLayoutEffect(() => {
    if (cardsHidden && cardsRef.current?.contains(document.activeElement)) {
      textareaRef.current?.focus({ preventScroll: true });
    }
  }, [cardsHidden]);
  const pasteEditor = usePasteEditor(
    { input: draftInput, ...draftPastes },
    (next) => commitDraft(next.input, pastedText(next)),
    sessionIdentity,
  );
  const inputPropRef = useRef(input);
  const pastesPropRef = useRef(pastes);
  const inputSyncRevisionRef = useRef(inputSyncRevision);
  const draftSessionIdentityRef = useRef(sessionIdentity);
  const initialCaretPendingRef = useRef(true);
  const resizeFrameRef = useRef<number | null>(null);
  const nativeFieldSizing = useMemo(
    () =>
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("field-sizing", "content"),
    [],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreTextareaAfterProjectChangeRef = useRef(false);
  const viewportBaselineRef = useRef(viewportHeight());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const stoppedMediaStreamsRef = useRef(new WeakSet<MediaStream>());
  const activeRecordingRef = useRef<RecordingCapture | null>(null);
  const aliveRef = useRef(true);
  const recordingTimerRef = useRef<number | undefined>(undefined);
  const recordingLimitRef = useRef<number | undefined>(undefined);
  const transcriptionStartedAtRef = useRef(0);
  const transcriptionTimerRef = useRef<number | undefined>(undefined);
  const retryRecordingsRef = useRef(
    new Map<
      string | undefined,
      {
        recording: ComposerRecording;
        submit(recording: ComposerRecording): Promise<void>;
      }
    >(),
  );
  const insertionRef = useRef<{ start: number; end: number } | null>(null);
  const [skillCaret, setSkillCaret] = useState<number | null>(null);
  const [skillDismissedToken, setSkillDismissedToken] = useState<string | null>(null);
  const [requestedSkillsCwd, setRequestedSkillsCwd] = useState<string | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const pendingAttachmentScopesRef = useRef(new Map<number, number>());
  const attachmentBatchesRef = useRef(new Map<number, Promise<void>>());
  const attachmentImagesRef = useRef(new Map<number, ComposerImage[]>());
  const attachmentFilesRef = useRef(new Map<number, ThreadFileAttachment[]>());
  const sessionIdentityRef = useRef(sessionIdentity);
  const latestPropsRef = useRef({
    attachmentScope,
    goalMode,
    images,
    files,
    input: draftInput,
    language,
    onImagesChange,
    onFilesChange,
    onUploadFiles,
    onInput,
    onLayoutChange,
    onPendingAttachmentsChange,
    onRecordingReady,
    preserveRecordingOnSessionChange,
    onTranscribe,
    sessionIdentity,
    t,
    transcriptionConfig,
  });
  latestPropsRef.current = {
    attachmentScope,
    goalMode,
    images,
    files,
    input: draftInput,
    language,
    onImagesChange,
    onFilesChange,
    onUploadFiles,
    onInput,
    onLayoutChange,
    onPendingAttachmentsChange,
    onRecordingReady,
    preserveRecordingOnSessionChange,
    onTranscribe,
    sessionIdentity,
    t,
    transcriptionConfig,
  };
  useLayoutEffect(() => {
    const activeRecording = activeRecordingRef.current;
    if (!activeRecording || activeRecording.sessionIdentity !== sessionIdentity) return;
    activeRecording.submit = onRecordingReady;
    activeRecording.transcribe = onTranscribe;
    activeRecording.preserveOnSessionChange = preserveRecordingOnSessionChange;
  }, [onRecordingReady, onTranscribe, preserveRecordingOnSessionChange, sessionIdentity]);

  useLayoutEffect(() => {
    const composer = formRef.current;
    const pane = composer?.closest<HTMLElement>(".conversation-pane");
    const scroll = pane?.querySelector<HTMLElement>(".conversation-scroll");
    if (!composer || !pane || !scroll) return;
    let previousHeight = -1;
    const updateHeight = (height: number) => {
      const nextHeight = Math.ceil(height);
      if (nextHeight === previousHeight) return false;
      previousHeight = nextHeight;
      pane.style.setProperty("--composer-overlay-height", `${nextHeight}px`);
      return true;
    };
    updateHeight(composer.getBoundingClientRect().height);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries.find((candidate) => candidate.target === composer);
            const heightChanged = entry
              ? updateHeight(
                  entry.borderBoxSize?.[0]?.blockSize ?? composer.getBoundingClientRect().height,
                )
              : false;
            if (heightChanged || entries.some((candidate) => candidate.target === scroll)) {
              latestPropsRef.current.onLayoutChange?.();
            }
          });
    observer?.observe(composer, { box: "border-box" });
    observer?.observe(scroll);
    return () => {
      observer?.disconnect();
      pane.style.removeProperty("--composer-overlay-height");
    };
  }, []);
  const [viewer, setViewer] = useState<{ index: number; opener: HTMLElement } | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  useEffect(
    () =>
      onBeforeAppReload(async () => {
        if (speechState !== "idle") throw new Error("Voice input is still in progress");
        await Promise.all(attachmentBatchesRef.current.values());
      }),
    [speechState],
  );
  const [hasRetryRecording, setHasRetryRecording] = useState(false);
  const [retryRecordingCount, setRetryRecordingCount] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcribingSeconds, setTranscribingSeconds] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const localSpeechBusy = speechState !== "idle";
  const speechBusy =
    localSpeechBusy || voiceUploadPending || voiceInputLocked || Boolean(transcriptionStatus);
  const transcriptionBusy = speechState === "transcribing" || Boolean(transcriptionStatus);
  const hasContent =
    !!draftPastes.pasteBlocks?.length ||
    Boolean(draftInput.trim()) ||
    images.length > 0 ||
    files.length > 0 ||
    annotations.length > 0 ||
    hasSupplementalContent;
  const activeSkillToken =
    !goalMode && !busy && !speechBusy && composerFocused
      ? skillTokenAt(draftInput, skillCaret)
      : null;
  const activeSkillTokenKey = skillTokenKey(activeSkillToken);
  const skillMenuOpen =
    Boolean(cwd && activeSkillToken) && activeSkillTokenKey !== skillDismissedToken;
  const skills = useSkillsCatalog(cwd, skillsEpoch, Boolean(cwd && requestedSkillsCwd === cwd));
  const matchingSkills = useMemo(
    () => filterSkills(skills.catalog?.skills ?? [], activeSkillToken?.query ?? "", language),
    [activeSkillToken?.query, language, skills.catalog?.skills],
  );
  const canSubmit =
    !inputUnavailable &&
    hasContent &&
    (!goalMode || Boolean(draftInput.trim())) &&
    !busy &&
    !settingsBusy &&
    !speechBusy &&
    (!creating || Boolean(projectId));
  const canSendQueuedNow =
    !inputUnavailable &&
    !hasContent &&
    !busy &&
    !settingsBusy &&
    !speechBusy &&
    Boolean(onSendQueuedNow);
  const planToggleEligible =
    application.capabilities.plan &&
    !running &&
    !busy &&
    !settingsBusy &&
    !settingsDisabled &&
    !speechBusy &&
    !goal &&
    Boolean(
      settings.model
        ? models.some((model) => model.id === settings.model)
        : (models.find((model) => model.isDefault) ?? models[0]),
    );
  const speechUnavailable = microphoneUnavailableReason(
    transcriptionConfig,
    transcriptionProvider,
    Boolean(onTranscribe || onRecordingReady),
    t,
  );
  const remoteTranscriptionStatus = transcriptionStatus?.status ?? "transcribing";
  const transcriptionStatusText = transcriptionStatus
    ? remoteTranscriptionStatus === "uploading"
      ? t("Отправляем запись — не закрывайте")
      : remoteTranscriptionStatus === "queued"
        ? t("На сервере · ожидание {{time}}", {
            time: formatRecordingTime(transcriptionStatus.elapsedSeconds),
          })
        : remoteTranscriptionStatus === "applying"
          ? t("На сервере · готовим результат")
          : t("На сервере · {{status}}", {
              status: formatTranscriptionStatus(
                transcriptionStatus.elapsedSeconds,
                transcriptionStatus.estimatedTotalSeconds,
                t,
              ).toLocaleLowerCase(language),
            })
    : null;
  const transcriptionTimerText = transcriptionStatus
    ? remoteTranscriptionStatus === "uploading" || remoteTranscriptionStatus === "queued"
      ? formatTimerSeconds(transcriptionStatus.elapsedSeconds)
      : remoteTranscriptionStatus === "transcribing"
        ? formatTranscriptionTimer(
            transcriptionStatus.elapsedSeconds,
            transcriptionStatus.estimatedTotalSeconds,
          )
        : null
    : speechState === "transcribing"
      ? formatTimerSeconds(transcribingSeconds)
      : null;
  const speechTimerText =
    speechState === "recording" ? formatTimerSeconds(recordingSeconds) : transcriptionTimerText;
  const speechStatusText =
    speechState === "recording"
      ? t("Запись {{time}}", { time: formatRecordingTime(recordingSeconds) })
      : (transcriptionStatusText ??
        (speechState === "uploading"
          ? t("Отправляем запись — не закрывайте")
          : speechState === "transcribing"
            ? formatTranscriptionStatus(transcribingSeconds, null, t)
            : voiceUploadPending
              ? t("Отправляем запись — не закрывайте")
              : null));
  const composerError =
    localizeKnownServerText(language, error) ??
    attachmentError ??
    speechError ??
    transcriptionError;
  const voiceTranscriptionErrorVisible =
    !error && !attachmentError && !speechError && Boolean(transcriptionError);

  useLayoutEffect(() => {
    const sessionChanged = draftSessionIdentityRef.current !== sessionIdentity;
    const inputChanged = inputPropRef.current !== input;
    const syncRequested = inputSyncRevisionRef.current !== inputSyncRevision;
    const pastesChanged = !samePastedText(pastesPropRef.current, pastes);
    if (!sessionChanged && !inputChanged && !syncRequested && !pastesChanged) return;
    if (sessionChanged) initialCaretPendingRef.current = true;
    pastesPropRef.current = pastes;
    draftSessionIdentityRef.current = sessionIdentity;
    inputPropRef.current = input;
    inputSyncRevisionRef.current = inputSyncRevision;
    draftInputRef.current = input;
    setDraftInput(input);
    const nextPastes = pastedText(pastes);
    draftPastesRef.current = nextPastes;
    setDraftPastes(nextPastes);
  }, [input, inputSyncRevision, sessionIdentity, pastes]);

  useEffect(() => {
    if (nativeFieldSizing) return;
    scheduleTextareaResize();
  }, [draftInput, nativeFieldSizing, messageFontSize]);

  useEffect(() => {
    if (nativeFieldSizing) return;
    scheduleTextareaResize();
    const textarea = textareaRef.current;
    let previousWidth: number | undefined;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width === undefined || width === previousWidth) return;
            previousWidth = width;
            scheduleTextareaResize();
          });
    if (textarea) observer?.observe(textarea);
    return () => {
      observer?.disconnect();
      cancelTextareaResize();
    };
  }, [nativeFieldSizing, sessionIdentity]);

  useLayoutEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus, sessionIdentity]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    // Draft hydration can follow focus or a session change. Wait for the new
    // value to reach the DOM, and stop restoring once the user takes over.
    if (!textarea || !initialCaretPendingRef.current || draftInput !== input) return;
    const length = textarea.value.length;
    textarea.setSelectionRange(
      Math.min(initialSelection?.start ?? length, length),
      Math.min(initialSelection?.end ?? length, length),
    );
    if (!initialSelection) textarea.scrollTop = textarea.scrollHeight;
  }, [draftInput, initialSelection, input, sessionIdentity]);

  useEffect(() => {
    if (viewer && viewer.index >= images.length) setViewer(null);
  }, [images.length, viewer]);

  useEffect(() => {
    if (!retryRecordingCount && speechState === "idle") return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [retryRecordingCount, speechState]);

  useEffect(() => {
    if (activeSkillIndex >= matchingSkills.length) setActiveSkillIndex(0);
  }, [activeSkillIndex, matchingSkills.length]);

  useEffect(() => {
    if (!running || !onStop) return;
    const stop = onStop;

    function handleStopTask(event: globalThis.KeyboardEvent) {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      stop();
    }

    window.addEventListener("keydown", handleStopTask);
    return () => window.removeEventListener("keydown", handleStopTask);
  }, [onStop, running]);

  useLayoutEffect(() => {
    attachmentImagesRef.current.set(attachmentScope, images);
  }, [attachmentScope, images]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    function updateKeyboardState() {
      const height = viewportHeight();
      if (document.activeElement !== textarea) {
        viewportBaselineRef.current = height;
        setKeyboardOpen(false);
        return;
      }
      setKeyboardOpen(viewportBaselineRef.current - height > KEYBOARD_VIEWPORT_DELTA);
    }

    function captureViewportBaseline() {
      viewportBaselineRef.current = Math.max(viewportBaselineRef.current, viewportHeight());
      updateKeyboardState();
    }

    function preserveFocusForButton(event: PointerEvent) {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (
        button instanceof HTMLButtonElement &&
        !button.disabled &&
        document.activeElement === textarea &&
        viewportBaselineRef.current - viewportHeight() > KEYBOARD_VIEWPORT_DELTA
      ) {
        event.preventDefault();
      }
    }

    textarea.addEventListener("focus", captureViewportBaseline);
    textarea.addEventListener("blur", updateKeyboardState);
    document.addEventListener("pointerdown", preserveFocusForButton, true);
    window.addEventListener("resize", updateKeyboardState);
    window.visualViewport?.addEventListener("resize", updateKeyboardState);
    updateKeyboardState();
    return () => {
      textarea.removeEventListener("focus", captureViewportBaseline);
      textarea.removeEventListener("blur", updateKeyboardState);
      document.removeEventListener("pointerdown", preserveFocusForButton, true);
      window.removeEventListener("resize", updateKeyboardState);
      window.visualViewport?.removeEventListener("resize", updateKeyboardState);
    };
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearRecordingTimers();
      clearTranscriptionTimer();
      const recorder = mediaRecorderRef.current;
      const recording = activeRecordingRef.current;
      if (recorder && recorder.state !== "inactive") {
        if (recording && !recording.preserveOnSessionChange) recording.discarded = true;
        recorder.stop();
      }
      stopMediaStream(recording?.stream);
      mediaRecorderRef.current = null;
      activeRecordingRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (sessionIdentityRef.current === sessionIdentity) return;
    sessionIdentityRef.current = sessionIdentity;
    setHasRetryRecording(retryRecordingsRef.current.has(sessionIdentity));
    clearRecordingTimers();
    clearTranscriptionTimer();
    const recorder = mediaRecorderRef.current;
    const recording = activeRecordingRef.current;
    if (recorder && recorder.state !== "inactive") {
      if (recording && !recording.preserveOnSessionChange) recording.discarded = true;
      recorder.stop();
    }
    stopMediaStream(recording?.stream);
    mediaRecorderRef.current = null;
    activeRecordingRef.current = null;
    insertionRef.current = null;
    setSkillCaret(null);
    setSkillDismissedToken(null);
    setRequestedSkillsCwd(null);
    setActiveSkillIndex(0);
    setComposerFocused(false);
    pendingAttachmentScopesRef.current.clear();
    attachmentBatchesRef.current.clear();
    attachmentImagesRef.current.clear();
    attachmentFilesRef.current.clear();
    setViewer(null);
    setCardsExpanded(false);
    setAttachmentError(null);
    setSpeechError(null);
    setSpeechState("idle");
    setRecordingSeconds(0);
    setTranscribingSeconds(0);
  }, [sessionIdentity]);

  function keyboardSubmit(event: KeyboardEvent<HTMLTextAreaElement>) {
    const unmodified = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
    if (skillMenuOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" && matchingSkills.length) {
        event.preventDefault();
        setActiveSkillIndex((current) => (current + 1) % matchingSkills.length);
        return;
      }
      if (event.key === "ArrowUp" && matchingSkills.length) {
        event.preventDefault();
        setActiveSkillIndex((current) => (current <= 0 ? matchingSkills.length - 1 : current - 1));
        return;
      }
      if (unmodified && (event.key === "Enter" || event.key === "Tab") && matchingSkills.length) {
        event.preventDefault();
        if (event.repeat) return;
        insertSkill(matchingSkills[Math.min(activeSkillIndex, matchingSkills.length - 1)]!);
        return;
      }
      if (event.key === "Escape" && activeSkillTokenKey) {
        event.preventDefault();
        setSkillDismissedToken(activeSkillTokenKey);
        return;
      }
    }

    if (
      event.key === "Tab" &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      planToggleEligible
    ) {
      event.preventDefault();
      if (event.repeat) return;
      onGoalModeChange?.(false);
      onSettingsChange({
        collaborationMode: settings.collaborationMode === "plan" ? "default" : "plan",
      });
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (event.repeat) return;
    const immediate = event.metaKey || event.ctrlKey;
    if (immediate && canSendQueuedNow) {
      onSendQueuedNow?.();
      return;
    }
    if (!canSubmit) return;
    onSubmit(immediate ? "immediate" : "queue");
  }

  async function addImages(files: readonly File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const operationIdentity = latestPropsRef.current.sessionIdentity;
    const scope = latestPropsRef.current.attachmentScope;
    if (!attachmentImagesRef.current.has(scope)) {
      attachmentImagesRef.current.set(scope, latestPropsRef.current.images);
    }
    setAttachmentError(null);
    pendingAttachmentScopesRef.current.set(
      scope,
      (pendingAttachmentScopesRef.current.get(scope) ?? 0) + 1,
    );
    latestPropsRef.current.onPendingAttachmentsChange?.(true, scope);
    const read = Promise.all(
      imageFiles.map(async (file, index) => ({
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        name: file.name.trim() || pastedImageName(file.type, index),
        url: await readImage(file),
      })),
    );
    const previousBatch = attachmentBatchesRef.current.get(scope) ?? Promise.resolve();
    const batch = previousBatch
      .catch(() => undefined)
      .then(async () => {
        const added = await read;
        if (!aliveRef.current || latestPropsRef.current.sessionIdentity !== operationIdentity) {
          return;
        }
        const next = [...(attachmentImagesRef.current.get(scope) ?? []), ...added];
        attachmentImagesRef.current.set(scope, next);
        latestPropsRef.current.onImagesChange(next, scope);
      });
    attachmentBatchesRef.current.set(scope, batch);
    try {
      await batch;
    } catch {
      if (aliveRef.current && latestPropsRef.current.sessionIdentity === operationIdentity) {
        setAttachmentError(latestPropsRef.current.t("Не удалось прочитать выбранное изображение"));
      }
    } finally {
      if (attachmentBatchesRef.current.get(scope) === batch) {
        attachmentBatchesRef.current.delete(scope);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      const pendingInScope = Math.max(0, (pendingAttachmentScopesRef.current.get(scope) ?? 1) - 1);
      if (pendingInScope) {
        pendingAttachmentScopesRef.current.set(scope, pendingInScope);
      } else {
        pendingAttachmentScopesRef.current.delete(scope);
      }
      if (aliveRef.current && latestPropsRef.current.sessionIdentity === operationIdentity) {
        latestPropsRef.current.onPendingAttachmentsChange?.(pendingInScope > 0, scope);
      }
    }
  }

  async function addFiles(selected: readonly File[]) {
    const upload = latestPropsRef.current.onUploadFiles;
    if (!selected.length || !upload) return;
    const operationIdentity = latestPropsRef.current.sessionIdentity;
    const scope = latestPropsRef.current.attachmentScope;
    if (!attachmentFilesRef.current.has(scope)) {
      attachmentFilesRef.current.set(scope, latestPropsRef.current.files);
    }
    setAttachmentError(null);
    pendingAttachmentScopesRef.current.set(
      scope,
      (pendingAttachmentScopesRef.current.get(scope) ?? 0) + 1,
    );
    latestPropsRef.current.onPendingAttachmentsChange?.(true, scope);
    const read = upload(selected, scope);
    const previousBatch = attachmentBatchesRef.current.get(scope) ?? Promise.resolve();
    const batch = previousBatch
      .catch(() => undefined)
      .then(async () => {
        const added = await read;
        if (!aliveRef.current || latestPropsRef.current.sessionIdentity !== operationIdentity) {
          return;
        }
        const next = [...(attachmentFilesRef.current.get(scope) ?? []), ...added];
        attachmentFilesRef.current.set(scope, next);
        latestPropsRef.current.onFilesChange?.(next, scope);
      });
    attachmentBatchesRef.current.set(scope, batch);
    try {
      await batch;
    } catch (caught) {
      if (aliveRef.current && latestPropsRef.current.sessionIdentity === operationIdentity) {
        setAttachmentError(
          caught instanceof Error
            ? localizeKnownServerText(latestPropsRef.current.language, caught.message)
            : latestPropsRef.current.t("Не удалось загрузить выбранный файл"),
        );
      }
    } finally {
      if (attachmentBatchesRef.current.get(scope) === batch) {
        attachmentBatchesRef.current.delete(scope);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      const pendingInScope = Math.max(0, (pendingAttachmentScopesRef.current.get(scope) ?? 1) - 1);
      if (pendingInScope) pendingAttachmentScopesRef.current.set(scope, pendingInScope);
      else pendingAttachmentScopesRef.current.delete(scope);
      if (aliveRef.current && latestPropsRef.current.sessionIdentity === operationIdentity) {
        latestPropsRef.current.onPendingAttachmentsChange?.(pendingInScope > 0, scope);
      }
    }
  }

  async function addSelectedFiles(selected: readonly File[]) {
    if (!selected.length) return;
    const existingBytes =
      files.reduce((total, file) => total + file.size, 0) +
      images.reduce((total, image) => total + inlineImageBytes(image.url), 0);
    if (selected.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      setAttachmentError(t("Размер одного файла не должен превышать 100 МБ"));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (
      existingBytes + selected.reduce((total, file) => total + file.size, 0) >
      MAX_MESSAGE_ATTACHMENT_BYTES
    ) {
      setAttachmentError(t("Общий размер вложений не должен превышать 250 МБ"));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const imageFiles = selected.filter((file) => file.type.startsWith("image/"));
    const otherFiles = selected.filter((file) => !file.type.startsWith("image/"));
    await Promise.all([addImages(imageFiles), addFiles(otherFiles)]);
  }

  function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = clipboardImageFiles(event.clipboardData);
    if (files.length) void addImages(files);
  }

  function captureInsertionPoint() {
    const textarea = textareaRef.current;
    const currentInput = draftInputRef.current;
    insertionRef.current = textarea
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : { start: currentInput.length, end: currentInput.length };
    const caret = textarea?.selectionStart ?? currentInput.length;
    setSkillCaret(caret);
    requestSkillsForToken(currentInput, caret);
  }

  function requestSkillsForToken(value: string, caret: number) {
    if (cwd && !goalMode && skillTokenAt(value, caret)) setRequestedSkillsCwd(cwd);
  }

  function insertSkill(skill: SkillCatalogItem) {
    const currentInput = draftInputRef.current;
    const currentToken = skillTokenAt(currentInput, skillCaret);
    if (!currentToken) return;
    const replacement = replaceSkillToken(currentInput, currentToken, skill.name);
    publishDraft(replacement.value);
    setSkillCaret(replacement.caret);
    setSkillDismissedToken(skillTokenKey(skillTokenAt(replacement.value, replacement.caret)));
    insertionRef.current = { start: replacement.caret, end: replacement.caret };
    window.setTimeout(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(replacement.caret, replacement.caret);
    });
  }

  async function startRecording() {
    if (
      speechState !== "idle" ||
      transcriptionStatus ||
      voiceUploadPending ||
      voiceInputLocked ||
      inputUnavailable ||
      busy ||
      settingsBusy
    ) {
      return;
    }
    const unavailable = microphoneUnavailableReason(
      transcriptionConfig,
      transcriptionProvider,
      Boolean(onTranscribe || onRecordingReady),
      t,
    );
    if (unavailable) {
      setSpeechError(unavailable);
      return;
    }
    const mimeType = recordingMimeType();
    if (!mimeType) {
      setSpeechError(t("Этот браузер не поддерживает запись WebM или MP4"));
      return;
    }
    if (!insertionRef.current) {
      const latestInput = draftInputRef.current;
      insertionRef.current = { start: latestInput.length, end: latestInput.length };
    }
    const recordingIdentity = latestPropsRef.current.sessionIdentity;
    setSpeechError(null);
    setSpeechState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current || latestPropsRef.current.sessionIdentity !== recordingIdentity) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      const latest = latestPropsRef.current;
      const latestInput = draftInputRef.current;
      const recording: RecordingCapture = {
        id: createVoiceRecordingId(),
        sessionIdentity: recordingIdentity,
        recorder,
        stream,
        chunks: [],
        bytes: 0,
        startedAt: Date.now(),
        selection: insertionRef.current ?? {
          start: latestInput.length,
          end: latestInput.length,
        },
        maxUploadBytes: latest.transcriptionConfig?.maxUploadBytes ?? 24 * 1024 * 1024,
        discarded: false,
        preserveOnSessionChange: latest.preserveRecordingOnSessionChange,
        ...(latest.onRecordingReady ? { submit: latest.onRecordingReady } : {}),
        ...(latest.onTranscribe ? { transcribe: latest.onTranscribe } : {}),
      };
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      activeRecordingRef.current = recording;
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size) return;
        recording.chunks.push(event.data);
        recording.bytes += event.data.size;
        if (recording.bytes >= recording.maxUploadBytes) stopRecording(recording);
      });
      recorder.addEventListener("error", () => {
        recording.discarded = true;
        if (activeRecordingRef.current === recording) {
          clearRecordingTimers();
          clearTranscriptionTimer();
          mediaRecorderRef.current = null;
          activeRecordingRef.current = null;
        }
        stopMediaStream(recording.stream);
        if (aliveRef.current && latestPropsRef.current.sessionIdentity === recordingIdentity) {
          setSpeechState("idle");
          setSpeechError(latestPropsRef.current.t("Не удалось записать аудио"));
        }
      });
      recorder.addEventListener("stop", () => void finishRecording(mimeType, recording));
      recorder.start(1_000);
      recording.startedAt = Date.now();
      setRecordingSeconds(0);
      setSpeechState("recording");
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(Math.max(0, Math.floor((Date.now() - recording.startedAt) / 1_000)));
      }, 250);
      recordingLimitRef.current = window.setTimeout(
        () => stopRecording(recording),
        (latestPropsRef.current.transcriptionConfig?.maxRecordingSeconds ?? 300) * 1_000,
      );
    } catch (caught) {
      stopMediaStream();
      if (aliveRef.current && latestPropsRef.current.sessionIdentity === recordingIdentity) {
        setSpeechState("idle");
        setSpeechError(recordingErrorMessage(caught, latestPropsRef.current.t));
      }
    }
  }

  function stopRecording(recording = activeRecordingRef.current) {
    const recorder = recording?.recorder;
    if (!recorder || recorder.state === "inactive") return;
    if (activeRecordingRef.current === recording) clearRecordingTimers();
    if (aliveRef.current && latestPropsRef.current.sessionIdentity === recording.sessionIdentity) {
      startTranscriptionTimer();
      if (recording.submit) {
        setSpeechState("uploading");
      } else {
        setSpeechState("transcribing");
      }
    }
    recorder.stop();
    stopMediaStream(recording.stream);
  }

  function cancelRecording() {
    const recording = activeRecordingRef.current;
    const recorder = recording?.recorder;
    if (!recorder || recorder.state === "inactive") return;
    recording.discarded = true;
    clearRecordingTimers();
    recorder.stop();
    stopMediaStream(recording.stream);
  }

  async function finishRecording(mimeType: string, capture: RecordingCapture) {
    const ownedUi = activeRecordingRef.current === capture;
    if (ownedUi) {
      clearRecordingTimers();
      mediaRecorderRef.current = null;
      activeRecordingRef.current = null;
    }
    stopMediaStream(capture.stream);
    const recordingIdentity = capture.sessionIdentity;
    if (capture.discarded) {
      if (ownedUi) clearTranscriptionTimer();
      if (
        ownedUi &&
        aliveRef.current &&
        latestPropsRef.current.sessionIdentity === recordingIdentity
      ) {
        setRecordingSeconds(0);
        setSpeechState("idle");
      }
      return;
    }
    if (!capture.chunks.length || !capture.bytes) {
      if (
        ownedUi &&
        aliveRef.current &&
        latestPropsRef.current.sessionIdentity === recordingIdentity
      ) {
        clearTranscriptionTimer();
        setSpeechState("idle");
        setSpeechError(latestPropsRef.current.t("Запись не содержит аудио"));
      }
      return;
    }
    if (capture.bytes > capture.maxUploadBytes) {
      if (
        ownedUi &&
        aliveRef.current &&
        latestPropsRef.current.sessionIdentity === recordingIdentity
      ) {
        clearTranscriptionTimer();
        setSpeechState("idle");
        setSpeechError(latestPropsRef.current.t("Запись слишком большая"));
      }
      return;
    }
    const recording = {
      id: capture.id,
      audio: new Blob(capture.chunks, { type: mimeType }),
      durationMs: Math.max(1, Date.now() - capture.startedAt),
      selection: capture.selection,
    };
    if (capture.submit) {
      retryRecordingsRef.current.set(recordingIdentity, {
        recording,
        submit: capture.submit,
      });
      if (aliveRef.current) {
        setRetryRecordingCount(retryRecordingsRef.current.size);
        if (ownedUi && latestPropsRef.current.sessionIdentity === recordingIdentity) {
          setHasRetryRecording(true);
        }
      }
      try {
        await capture.submit(recording);
        if (retryRecordingsRef.current.get(recordingIdentity)?.recording.id === recording.id) {
          retryRecordingsRef.current.delete(recordingIdentity);
          if (aliveRef.current) {
            setRetryRecordingCount(retryRecordingsRef.current.size);
            if (ownedUi && latestPropsRef.current.sessionIdentity === recordingIdentity) {
              setHasRetryRecording(false);
            }
          }
        }
        if (
          ownedUi &&
          aliveRef.current &&
          latestPropsRef.current.sessionIdentity === recordingIdentity
        ) {
          setSpeechError(null);
        }
      } catch (caught) {
        if (
          ownedUi &&
          aliveRef.current &&
          latestPropsRef.current.sessionIdentity === recordingIdentity
        ) {
          const latest = latestPropsRef.current;
          setSpeechError(
            caught instanceof Error
              ? localizeKnownServerText(latest.language, caught.message)
              : latest.t("Не удалось отправить запись на сервер"),
          );
        }
      } finally {
        if (
          ownedUi &&
          aliveRef.current &&
          latestPropsRef.current.sessionIdentity === recordingIdentity
        ) {
          clearTranscriptionTimer();
          setSpeechState("idle");
        }
      }
      return;
    }
    if (
      !ownedUi ||
      !aliveRef.current ||
      latestPropsRef.current.sessionIdentity !== recordingIdentity ||
      !capture.transcribe
    ) {
      if (ownedUi) clearTranscriptionTimer();
      return;
    }
    try {
      const transcript = await capture.transcribe(recording.audio, recording.durationMs);
      if (!aliveRef.current || latestPropsRef.current.sessionIdentity !== recordingIdentity) {
        return;
      }
      insertTranscript(transcript);
      setSpeechError(null);
    } catch (caught) {
      if (aliveRef.current && latestPropsRef.current.sessionIdentity === recordingIdentity) {
        const latest = latestPropsRef.current;
        setSpeechError(
          caught instanceof Error
            ? localizeKnownServerText(latest.language, caught.message)
            : latest.t("Не удалось распознать запись"),
        );
      }
    } finally {
      clearTranscriptionTimer();
      if (aliveRef.current && latestPropsRef.current.sessionIdentity === recordingIdentity) {
        setSpeechState("idle");
      }
    }
  }

  async function retryVoiceRecording(): Promise<void> {
    const retryIdentity = latestPropsRef.current.sessionIdentity;
    const retry = retryRecordingsRef.current.get(retryIdentity);
    if (!retry || speechState !== "idle") return;
    setSpeechError(null);
    setSpeechState("uploading");
    startTranscriptionTimer();
    try {
      await retry.submit(retry.recording);
      if (retryRecordingsRef.current.get(retryIdentity)?.recording.id === retry.recording.id) {
        retryRecordingsRef.current.delete(retryIdentity);
        setRetryRecordingCount(retryRecordingsRef.current.size);
        setHasRetryRecording(false);
      }
    } catch (caught) {
      const latest = latestPropsRef.current;
      setSpeechError(
        caught instanceof Error
          ? localizeKnownServerText(latest.language, caught.message)
          : latest.t("Не удалось отправить запись на сервер"),
      );
    } finally {
      clearTranscriptionTimer();
      if (aliveRef.current) setSpeechState("idle");
    }
  }

  function insertTranscript(transcript: string) {
    const latest = latestPropsRef.current;
    const currentInput = draftInputRef.current;
    const selection = insertionRef.current ?? {
      start: currentInput.length,
      end: currentInput.length,
    };
    const inserted = insertTranscriptAtSelection(
      currentInput,
      transcript,
      selection,
      latest.goalMode ? 4_000 : undefined,
    );
    if (!inserted) throw new Error(latest.t("Распознавание не вернуло текст"));
    publishDraft(inserted.value);
    window.setTimeout(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(inserted.caret, inserted.caret);
      insertionRef.current = { start: inserted.caret, end: inserted.caret };
    });
  }

  function clearRecordingTimers() {
    if (recordingTimerRef.current !== undefined) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = undefined;
    }
    if (recordingLimitRef.current !== undefined) {
      window.clearTimeout(recordingLimitRef.current);
      recordingLimitRef.current = undefined;
    }
  }

  function startTranscriptionTimer() {
    clearTranscriptionTimer();
    transcriptionStartedAtRef.current = Date.now();
    setTranscribingSeconds(0);
    transcriptionTimerRef.current = window.setInterval(() => {
      setTranscribingSeconds(
        Math.max(0, Math.floor((Date.now() - transcriptionStartedAtRef.current) / 1_000)),
      );
    }, 250);
  }

  function clearTranscriptionTimer() {
    if (transcriptionTimerRef.current === undefined) return;
    window.clearInterval(transcriptionTimerRef.current);
    transcriptionTimerRef.current = undefined;
  }

  function publishDraft(value: string) {
    pasteEditor.change(value);
  }

  function commitDraft(value: string, nextPastes: PastedText) {
    const hadPastes = Object.keys(draftPastesRef.current).length > 0;
    draftPastesRef.current = nextPastes;
    setDraftPastes(nextPastes);
    draftInputRef.current = value;
    latestPropsRef.current.input = value;
    setDraftInput(value);
    if (hadPastes || Object.keys(nextPastes).length)
      latestPropsRef.current.onInput(value, nextPastes);
    else latestPropsRef.current.onInput(value);
  }

  function scheduleTextareaResize() {
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      const scrollHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.min(scrollHeight, 190)}px`;
      textarea.style.overflowY = scrollHeight > 190 ? "auto" : "hidden";
    });
  }

  function cancelTextareaResize() {
    if (resizeFrameRef.current === null) return;
    window.cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = null;
  }

  function preserveTextareaFocus(event: ReactPointerEvent<HTMLElement>) {
    const textarea = textareaRef.current;
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest<HTMLElement>(
      "button:not(:disabled), select:not(:disabled), summary",
    );
    if (!textarea || !control || !event.currentTarget.contains(control)) return;
    if (control instanceof HTMLSelectElement) {
      restoreTextareaAfterProjectChangeRef.current = document.activeElement === textarea;
    } else if (document.activeElement === textarea) {
      event.preventDefault();
    }
  }

  function stopMediaStream(stream = mediaStreamRef.current) {
    if (stream && !stoppedMediaStreamsRef.current.has(stream)) {
      stoppedMediaStreamsRef.current.add(stream);
      stream.getTracks().forEach((track) => track.stop());
    }
    if (mediaStreamRef.current === stream) mediaStreamRef.current = null;
  }

  return (
    <form
      ref={formRef}
      className={`composer${keyboardOpen ? " keyboard-open" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit("queue");
      }}
    >
      {composerError && (
        <div
          className={`composer-error${voiceTranscriptionErrorVisible ? " voice-transcription-error" : ""}`}
          role="alert"
        >
          {voiceTranscriptionErrorVisible && <MicrophoneIcon />}
          <span>{composerError}</span>
          {voiceTranscriptionErrorVisible && onDismissTranscriptionError && (
            <button
              type="button"
              className="voice-transcription-error-dismiss"
              aria-label={t("Закрыть")}
              onClick={onDismissTranscriptionError}
            >
              ×
            </button>
          )}
        </div>
      )}
      {creating && projects.length === 0 && (
        <div className="composer-empty-projects">
          <span>{t("Чтобы начать задачу, добавьте рабочую папку.")}</span>
          <button type="button" onClick={onNewProject}>
            <PlusIcon /> {t("Добавить проект")}
          </button>
        </div>
      )}
      {children}
      <div className="composer-cards">
        {cardCount > 2 && (
          <button
            type="button"
            className={`composer-cards-toggle${cardsHidden ? " stacked" : ""}`}
            aria-expanded={cardsExpanded}
            aria-controls={cardsId}
            aria-label={`${t(
              cardsExpanded ? "Свернуть вложения ({{count}})" : "Развернуть вложения ({{count}})",
              { count: cardCount },
            )}: ${cardSummary}`}
            title={cardSummary}
            onPointerDownCapture={preserveTextareaFocus}
            onClick={() => setCardsExpanded(!cardsExpanded)}
          >
            <span className="composer-cards-toggle-surface">
              <span className="composer-cards-types" aria-hidden="true">
                {cardTypes.map(({ count, Icon, label }) => (
                  <span className="composer-card-type" key={label} title={label}>
                    <Icon />
                    <span>{count}</span>
                  </span>
                ))}
              </span>
              <ChevronDownIcon className={cardsExpanded ? "expanded" : undefined} />
            </span>
          </button>
        )}
        <div
          id={cardsId}
          ref={cardsRef}
          className={`composer-cards-content${cardCount > 2 ? " limited" : ""}`}
          hidden={cardsHidden}
        >
          {(images.length > 0 || files.length > 0) && (
            <div
              className="composer-attachments"
              aria-label={t("Вложения")}
              onPointerDownCapture={preserveTextareaFocus}
            >
              {images.map((image, index) => (
                <div className="composer-attachment" key={image.id}>
                  <button
                    type="button"
                    className="composer-attachment-preview"
                    aria-label={t("Открыть изображение {{name}}", { name: image.name })}
                    onClick={(event) => {
                      const activeElement = event.currentTarget.ownerDocument.activeElement;
                      setViewer({
                        index,
                        opener:
                          activeElement instanceof HTMLElement &&
                          activeElement !== event.currentTarget.ownerDocument.body
                            ? activeElement
                            : event.currentTarget,
                      });
                    }}
                  >
                    <img src={image.url} alt={image.name} />
                  </button>
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    aria-label={t("Удалить изображение {{name}}", { name: image.name })}
                    onClick={() => {
                      const next = images.filter((item) => item.id !== image.id);
                      attachmentImagesRef.current.set(attachmentScope, next);
                      latestPropsRef.current.onImagesChange(next, attachmentScope);
                    }}
                  >
                    <XIcon />
                  </button>
                </div>
              ))}
              {files.map((file) => (
                <div className="composer-attachment composer-file-attachment" key={file.id}>
                  <div className="composer-file-summary" title={file.name}>
                    <FileIcon />
                    <span>{file.name}</span>
                    <small>{formatFileSize(file.size, language)}</small>
                  </div>
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    aria-label={t("Удалить файл {{name}}", { name: file.name })}
                    onClick={() => {
                      const next = files.filter((item) => item.id !== file.id);
                      attachmentFilesRef.current.set(attachmentScope, next);
                      latestPropsRef.current.onFilesChange?.(next, attachmentScope);
                      void onDeleteFile?.(file).catch(() => undefined);
                    }}
                  >
                    <XIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
          <AnnotationBubbles
            annotations={annotations}
            disabled={busy}
            onOpen={(id) => onOpenAnnotation?.(id)}
            onDelete={(id) => onDeleteAnnotation?.(id)}
          />
          <PasteBlocks
            blocks={draftPastes.pasteBlocks}
            onChange={pasteEditor.blocks}
            disabled={speechBusy || inputUnavailable}
          />
        </div>
      </div>
      {viewer && (
        <ImageViewer
          images={images.map((image) => ({ src: image.url, alt: image.name }))}
          index={viewer.index}
          opener={viewer.opener}
          onIndexChange={(index) => setViewer({ ...viewer, index })}
          onClose={() => setViewer(null)}
        />
      )}
      <div className="composer-box">
        {skillMenuOpen && (
          <SkillAutocomplete
            skills={matchingSkills}
            loading={skills.loading}
            error={skills.error}
            activeIndex={activeSkillIndex}
            onActiveIndexChange={setActiveSkillIndex}
            onSelect={insertSkill}
          />
        )}
        <PasteTextarea
          editor={pasteEditor}
          pasteEnabled={!goalMode}
          ref={textareaRef}
          aria-label={running ? t("Направить текущую задачу") : t("Сообщение для Codex")}
          rows={1}
          maxLength={goalMode ? 4_000 : undefined}
          readOnly={speechBusy}
          aria-busy={speechBusy}
          aria-autocomplete={skillMenuOpen ? "list" : undefined}
          aria-controls={skillMenuOpen ? "composer-skill-list" : undefined}
          aria-expanded={skillMenuOpen || undefined}
          aria-activedescendant={
            skillMenuOpen && matchingSkills[activeSkillIndex]
              ? `composer-skill-${skillOptionId(matchingSkills[activeSkillIndex]!)}`
              : undefined
          }
          onChange={(event) => {
            initialCaretPendingRef.current = false;
            const caret = event.currentTarget.selectionStart;
            const value = event.currentTarget.value;
            setSkillCaret(caret);
            setActiveSkillIndex(0);
            setSkillDismissedToken(null);
            requestSkillsForToken(value, caret);
          }}
          onFocus={(event) => {
            setComposerFocused(true);
            setSkillDismissedToken(null);
            const caret = event.currentTarget.selectionStart;
            setSkillCaret(caret);
            requestSkillsForToken(event.currentTarget.value, caret);
          }}
          onBlur={() => {
            setComposerFocused(false);
            onDraftFlush?.();
          }}
          onPointerDown={() => {
            initialCaretPendingRef.current = false;
          }}
          onKeyDownCapture={() => {
            initialCaretPendingRef.current = false;
          }}
          onPaste={(event) => {
            initialCaretPendingRef.current = false;
            pasteImages(event);
          }}
          onSelect={captureInsertionPoint}
          onKeyDown={keyboardSubmit}
          placeholder={
            goalMode
              ? t("Опишите проверяемый результат цели…")
              : running
                ? t("Направить текущую задачу…")
                : t("Спросите что угодно")
          }
        />
        <div className="composer-toolbar" onPointerDownCapture={preserveTextareaFocus}>
          <div className="composer-options">
            <input
              ref={fileInputRef}
              type="file"
              accept={onUploadFiles ? undefined : "image/*"}
              multiple
              hidden
              onChange={(event) => void addSelectedFiles(Array.from(event.target.files ?? []))}
            />
            <button
              aria-label={onUploadFiles ? t("Добавить файлы") : t("Добавить изображения")}
              className="composer-add-image"
              type="button"
              disabled={speechBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon />
            </button>
            {creating && projects.length > 0 && (
              <label className="project-picker">
                <span className="sr-only">{t("Проект")}</span>
                <select
                  aria-label={t("Проект")}
                  value={projectId}
                  onBlur={() => {
                    restoreTextareaAfterProjectChangeRef.current = false;
                  }}
                  onChange={(event) => {
                    const restoreTextarea = restoreTextareaAfterProjectChangeRef.current;
                    restoreTextareaAfterProjectChangeRef.current = false;
                    onProjectChange?.(event.target.value);
                    if (restoreTextarea) textareaRef.current?.focus();
                  }}
                >
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <SettingsPicker
              effortDisabled={effortDisabled}
              disabled={running || busy || settingsBusy || settingsDisabled || speechBusy}
              teamToggleDisabled={
                busy ||
                settingsBusy ||
                settingsDisabled ||
                speechBusy ||
                (running && settings.collaborationMode !== "team")
              }
              models={models}
              value={settings}
              onChange={onSettingsChange}
              goalMode={goalMode}
              goal={goal}
              goalBusy={goalBusy}
              onGoalModeChange={onGoalModeChange}
              onGoalUpdate={onGoalUpdate}
              onGoalClear={onGoalClear}
            />
            {!application.isClaude &&
              codexSettings &&
              ((codexSettings.model !== null && codexSettings.model !== settings.model) ||
                (codexSettings.reasoningEffort !== null &&
                  codexSettings.reasoningEffort !== settings.reasoningEffort)) && (
                <span
                  className="composer-hint codex-settings-hint"
                  title={t(
                    "Настройки, сообщённые Codex; не модель конкретного ответа. Ваш выбор применится при следующей отправке.",
                  )}
                >
                  {t("В Codex: {{model}} · {{effort}}", {
                    model: codexSettings.model ?? t("Не сообщено"),
                    effort: codexSettings.reasoningEffort ?? t("Не сообщено"),
                  })}
                </span>
              )}
            {running && (
              <span className="composer-hint">{t("Сообщение будет добавлено в очередь")}</span>
            )}
          </div>
          <div className="composer-actions">
            {transcriptionConfig && (
              <>
                <button
                  aria-label={
                    speechState === "recording"
                      ? t("Остановить запись")
                      : speechState === "requesting"
                        ? t("Запрашиваем доступ к микрофону")
                        : speechState === "uploading"
                          ? t("Отправляем запись — не закрывайте")
                          : voiceUploadPending
                            ? t("Отправляем запись — не закрывайте")
                            : transcriptionStatus && remoteTranscriptionStatus === "queued"
                              ? t("Запись на сервере · можно закрыть")
                              : transcriptionStatus && remoteTranscriptionStatus === "applying"
                                ? t("На сервере · готовим результат")
                                : transcriptionBusy
                                  ? t("Распознаём запись")
                                  : speechUnavailable
                                    ? speechUnavailable
                                    : hasRetryRecording
                                      ? t("Повторить")
                                      : t("Начать запись")
                  }
                  aria-pressed={speechState === "recording"}
                  className={`composer-action microphone${speechState === "recording" ? " recording" : ""}${speechTimerText ? " timing" : ""}`}
                  disabled={
                    speechState === "requesting" ||
                    speechState === "uploading" ||
                    speechState === "transcribing" ||
                    voiceUploadPending ||
                    voiceInputLocked ||
                    Boolean(transcriptionStatus) ||
                    (speechState === "idle" &&
                      (inputUnavailable || busy || settingsBusy || Boolean(speechUnavailable)))
                  }
                  title={speechUnavailable ?? undefined}
                  type="button"
                  onPointerDown={
                    speechState === "idle" &&
                    !hasRetryRecording &&
                    !transcriptionStatus &&
                    !voiceInputLocked
                      ? captureInsertionPoint
                      : undefined
                  }
                  onClick={() =>
                    speechState === "recording"
                      ? stopRecording()
                      : hasRetryRecording
                        ? void retryVoiceRecording()
                        : void startRecording()
                  }
                >
                  {speechTimerText ? (
                    <span className="composer-action-timer" aria-hidden="true">
                      {speechTimerText}
                    </span>
                  ) : speechState === "requesting" ||
                    speechState === "uploading" ||
                    voiceUploadPending ||
                    remoteTranscriptionStatus === "applying" ? (
                    <span className="spinner small" />
                  ) : (
                    <MicrophoneIcon />
                  )}
                </button>
              </>
            )}
            {running && onStop && (
              <button
                aria-label={t("Остановить задачу")}
                className="composer-action stop composer-task-stop"
                type="button"
                onClick={onStop}
              >
                <StopIcon />
              </button>
            )}
            {speechState === "recording" ? (
              <button
                aria-label={t("Отменить запись")}
                className="composer-action stop"
                type="button"
                onClick={cancelRecording}
              >
                <XIcon />
              </button>
            ) : onCancelVoiceTranscription ? (
              <button
                aria-label={t("Отменить обработку записи")}
                className="composer-action stop"
                disabled={voiceCancellationPending}
                type="button"
                onClick={onCancelVoiceTranscription}
              >
                {voiceCancellationPending ? <span className="spinner small" /> : <XIcon />}
              </button>
            ) : (
              <button
                aria-label={
                  running
                    ? t("Добавить в очередь")
                    : goalMode
                      ? t("Запустить цель")
                      : t("Отправить")
                }
                className="composer-action send"
                disabled={!canSubmit}
                type="submit"
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
        {speechStatusText && (
          <span className="sr-only" role="status">
            {speechStatusText}
          </span>
        )}
      </div>
    </form>
  );
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("read failed"));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function clipboardImageFiles(data: DataTransfer): File[] {
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  if (itemFiles.length) return itemFiles;
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

function pastedImageName(mimeType: string, index: number): string {
  const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
  return `pasted-image-${index + 1}.${extension}`;
}

type SkillToken = {
  start: number;
  end: number;
  query: string;
};

function SkillAutocomplete({
  skills,
  loading,
  error,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  skills: SkillCatalogItem[];
  loading: boolean;
  error: unknown;
  activeIndex: number;
  onActiveIndexChange(index: number): void;
  onSelect(skill: SkillCatalogItem): void;
}) {
  const { language, t } = useI18n();
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const errorText =
    error instanceof Error
      ? (localizeKnownServerText(language, error.message) ?? error.message)
      : error
        ? t("Не удалось загрузить скиллы")
        : null;

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, skills]);

  return (
    <div
      className="skill-autocomplete"
      id="composer-skill-list"
      role="listbox"
      aria-label={t("Доступные скиллы")}
    >
      {skills.length ? (
        skills.map((skill, index) => (
          <button
            type="button"
            id={`composer-skill-${skillOptionId(skill)}`}
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? "active" : undefined}
            ref={index === activeIndex ? activeOptionRef : undefined}
            key={skill.path}
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => onActiveIndexChange(index)}
            onClick={() => onSelect(skill)}
          >
            <span>
              <strong>${skill.name}</strong>
              {skill.displayName !== skill.name && <small>{skill.displayName}</small>}
            </span>
            <p>{skill.shortDescription || skill.description}</p>
          </button>
        ))
      ) : (
        <div className="skill-autocomplete-state" role="status">
          {loading ? t("Загружаем скиллы…") : errorText ? errorText : t("Нет подходящих скиллов")}
        </div>
      )}
    </div>
  );
}

function skillTokenAt(value: string, caret: number | null): SkillToken | null {
  if (caret === null || caret < 0 || caret > value.length) return null;
  let start = caret;
  while (start > 0 && isSkillNameCharacter(value[start - 1]!)) start -= 1;
  if (start > 0 && value[start - 1] === "$") start -= 1;
  if (value[start] !== "$") return null;
  if (start > 0 && !/\s/u.test(value[start - 1]!)) return null;
  const query = value.slice(start + 1, caret);
  if ([...query].some((character) => !isSkillNameCharacter(character))) return null;
  let end = caret;
  while (end < value.length && isSkillNameCharacter(value[end]!)) end += 1;
  return { start, end, query };
}

function isSkillNameCharacter(value: string): boolean {
  return /[\p{L}\p{N}_.:-]/u.test(value);
}

function skillTokenKey(token: SkillToken | null): string | null {
  return token ? `${token.start}:${token.end}:${token.query}` : null;
}

function replaceSkillToken(
  value: string,
  token: SkillToken,
  name: string,
): { value: string; caret: number } {
  const marker = `$${name}`;
  const trailingSpace = token.end === value.length ? " " : "";
  const next = `${value.slice(0, token.start)}${marker}${trailingSpace}${value.slice(token.end)}`;
  return { value: next, caret: token.start + marker.length + trailingSpace.length };
}

function filterSkills(
  catalog: SkillCatalogItem[],
  query: string,
  language: string,
): SkillCatalogItem[] {
  const normalized = query.toLocaleLowerCase(language);
  return catalog
    .filter((skill) => {
      if (!skill.enabled) return false;
      if (!normalized) return true;
      return [skill.name, skill.displayName, skill.description, skill.shortDescription]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase(language).includes(normalized));
    })
    .sort((left, right) => {
      const leftStarts = left.name.toLocaleLowerCase(language).startsWith(normalized);
      const rightStarts = right.name.toLocaleLowerCase(language).startsWith(normalized);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.name.localeCompare(right.name, language);
    });
}

function skillOptionId(skill: SkillCatalogItem): string {
  return encodeURIComponent(skill.path).replaceAll("%", "");
}

function formatTranscriptionStatus(
  elapsedSeconds: number,
  estimatedTotalSeconds: number | null,
  t: Translate,
): string {
  if (estimatedTotalSeconds === null) {
    return t("Распознаём · прошло {{time}}", { time: formatRecordingTime(elapsedSeconds) });
  }
  if (elapsedSeconds <= estimatedTotalSeconds) {
    return t("Распознаём · осталось ≈ {{time}}", {
      time: formatRecordingTime(Math.max(0, estimatedTotalSeconds - elapsedSeconds)),
    });
  }
  return t("Распознаём · дольше прогноза на {{time}}", {
    time: formatRecordingTime(elapsedSeconds - estimatedTotalSeconds),
  });
}

function inlineImageBytes(url: string): number {
  const comma = url.indexOf(",");
  return comma < 0 ? 0 : Math.floor(((url.length - comma - 1) * 3) / 4);
}

function formatFileSize(bytes: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: bytes >= 1024 * 1024 ? "megabyte" : "kilobyte",
    unitDisplay: "short",
    maximumFractionDigits: bytes >= 10 * 1024 * 1024 ? 0 : 1,
  }).format(bytes / (bytes >= 1024 * 1024 ? 1024 * 1024 : 1024));
}
