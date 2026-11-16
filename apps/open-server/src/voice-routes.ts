import type { FastifyInstance } from "fastify";
import type {
  TranscriptionProvider,
  UpdateTranscriptionSettingsRequest,
} from "@codexnest/protocol";
import { AppError, type Engine } from "./engine";
import {
  OpenVoiceJobs,
  OpenVoiceService,
  createOpenRefiner,
  MAX_TRANSCRIPTION_BYTES,
  type VoiceUploadQuery,
} from "./voice";

export async function registerVoiceRoutes(
  app: FastifyInstance,
  engine: Engine,
  supplied?: OpenVoiceService,
) {
  const voice =
    supplied ??
    new OpenVoiceService({
      loadSettings: async () => engine.data.voiceSettings,
      saveSettings: async (settings) => {
        engine.data.voiceSettings = settings;
        await engine.save();
      },
      loadTimings: (profile) => engine.data.voiceTimings?.[profile],
      saveTimings: async (profile, samples) => {
        (engine.data.voiceTimings ??= {})[profile] = samples;
        await engine.save();
      },
      refine: createOpenRefiner((prompt, model, signal) => engine.oneShot(prompt, model, signal)),
    });
  await voice.readSettings();
  const voiceJobs = new OpenVoiceJobs(engine, voice);
  await voiceJobs.initialize();
  for (const mediaType of ["audio/webm", "audio/mp4"] as const) {
    app.addContentTypeParser(
      mediaType,
      { parseAs: "buffer", bodyLimit: MAX_TRANSCRIPTION_BYTES },
      (_req, body, done) => done(null, body),
    );
  }
  app.get("/api/v1/transcriptions/config", () => voice.configuration());
  app.put("/api/v1/settings/transcription", (req) =>
    voice.updateConfiguration(req.body as UpdateTranscriptionSettingsRequest),
  );
  app.post<{
    Querystring: {
      provider?: string;
      language?: string;
      refine?: string;
      refinementModel?: string;
    };
  }>("/api/v1/transcriptions", { bodyLimit: MAX_TRANSCRIPTION_BYTES }, async (req) => {
    if (!Buffer.isBuffer(req.body))
      throw new AppError("invalid_request", "Audio recording is required");
    const durationHeader = req.headers["x-codexnest-audio-duration-ms"];
    const audioDurationMs =
      durationHeader !== undefined && durationHeader !== "" ? Number(durationHeader) : undefined;
    const provider = req.query.provider as TranscriptionProvider | undefined;
    if (provider !== undefined && provider !== "local" && provider !== "openai")
      throw new AppError("invalid_request", "Invalid transcription provider");
    const refineLocal =
      req.query.refine === "true" ? true : req.query.refine === "false" ? false : undefined;
    const transcript = await voice.transcribe(
      req.body,
      req.headers["content-type"] ?? "",
      undefined,
      {
        audioDurationMs,
        provider,
        language: req.query.language,
        refineLocal,
        refinementModel: req.query.refinementModel,
      },
    );
    return {
      text: transcript,
      timingEstimate: voice.configuration().timingEstimate,
    };
  });
  app.post<{ Params: { id: string }; Querystring: VoiceUploadQuery }>(
    "/api/v1/threads/:id/voice-transcriptions",
    { bodyLimit: MAX_TRANSCRIPTION_BYTES },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body))
        throw new AppError("invalid_request", "Audio recording is required");
      const audioDurationMs = Number(req.headers["x-codexnest-audio-duration-ms"]);
      return reply.code(202).send({
        job: await voiceJobs.create(
          req.params.id,
          req.body,
          req.headers["content-type"] ?? "",
          req.query,
          audioDurationMs,
        ),
      });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/threads/:id/voice-transcriptions",
    async (req) => {
      await voiceJobs.cancel(req.params.id);
      return { cancelled: true };
    },
  );
  app.post<{ Params: { id: string; jobId: string } }>(
    "/api/v1/threads/:id/voice-transcriptions/:jobId/retry",
    async (req) => {
      await voiceJobs.retry(req.params.id, req.params.jobId);
      return { retried: true };
    },
  );
  app.addHook("onClose", () => voiceJobs.close());
  return { voice, voiceJobs };
}
