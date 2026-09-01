"use client";

import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Mic, Send, Square, X } from "lucide-react";
import clsx from "clsx";
import type { QuotedReply } from "@/lib/messaging/payloads";

/**
 * Composer: text, photo and voice note, with an optional quoted reply.
 *
 * Recording uses MediaRecorder and asks for the microphone only at the moment
 * the user presses record — never on mount, which would prompt for permission
 * merely for opening the page.
 */
export function MessageComposer({
  onSend,
  onSendMedia,
  sending,
  replyTo,
  onCancelReply,
  disabled,
  placeholder,
}: {
  onSend: (text: string, replyTo?: QuotedReply) => Promise<boolean>;
  onSendMedia: (file: File, kind: "image" | "voice", caption?: string, durationSec?: number, replyTo?: QuotedReply) => Promise<boolean>;
  sending: boolean;
  replyTo?: QuotedReply;
  onCancelReply: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [pendingImage, setPendingImage] = useState<{ file: File; preview: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedRef.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [recording]);

  // Revoke the object URL when the preview changes, or the tab leaks memory.
  useEffect(() => () => {
    if (pendingImage) URL.revokeObjectURL(pendingImage.preview);
  }, [pendingImage]);

  async function submit() {
    if (disabled || sending) return;
    setError(null);
    if (pendingImage) {
      const ok = await onSendMedia(pendingImage.file, "image", text.trim() || undefined, undefined, replyTo);
      if (ok) {
        URL.revokeObjectURL(pendingImage.preview);
        setPendingImage(null);
        setText("");
        onCancelReply();
      }
      return;
    }
    if (!text.trim()) return;
    const ok = await onSend(text, replyTo);
    if (ok) {
      setText("");
      onCancelReply();
      textareaRef.current?.focus();
    }
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const seconds = (Date.now() - startedRef.current) / 1000;
        if (seconds < 0.7) {
          setError("Too short — hold to record.");
          return;
        }
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
        await onSendMedia(file, "voice", undefined, seconds, replyTo);
        onCancelReply();
      };
      startedRef.current = Date.now();
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setElapsed(0);
    } catch {
      setError("Microphone unavailable. Check browser permissions.");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  return (
    <div className="border-t border-ink-700 p-3">
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-brand-500 bg-ink-850 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 text-[11.5px]">
            <span className="block font-medium text-mist-200">Replying to {replyTo.senderName}</span>
            <span className="block truncate text-mist-400">{replyTo.snippet}</span>
          </span>
          <button onClick={onCancelReply} className="text-mist-400 hover:text-mist-100"><X size={13} /></button>
        </div>
      )}

      {pendingImage && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pendingImage.preview} alt="Attachment preview" className="h-14 w-14 rounded object-cover" />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-mist-300">{pendingImage.file.name}</span>
          <button
            onClick={() => { URL.revokeObjectURL(pendingImage.preview); setPendingImage(null); }}
            className="text-mist-400 hover:text-bad-400"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {error && <p className="mb-2 text-[11.5px] text-bad-400">{error}</p>}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 15 * 1024 * 1024) { setError("Image is larger than 15MB."); return; }
            setPendingImage({ file: f, preview: URL.createObjectURL(f) });
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={disabled || recording}
          title="Attach a photo"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ink-700 text-mist-300 hover:border-ink-600 hover:text-mist-100 disabled:opacity-40"
        >
          <ImageIcon size={15} />
        </button>

        {recording ? (
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-bad-500/50 bg-bad-500/[0.07] px-3 py-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-bad-400" />
            <span className="tnum text-[12.5px] text-bad-400">Recording {elapsed}s</span>
            <button onClick={stopRecording} className="ml-auto flex items-center gap-1 text-[12px] text-mist-200 hover:text-mist-100">
              <Square size={12} /> Stop &amp; send
            </button>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline — the convention people expect.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={1}
            disabled={disabled}
            placeholder={placeholder ?? "Write a message…"}
            className="max-h-32 min-h-[38px] flex-1 resize-y rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-mist-500 focus:border-brand-500 disabled:opacity-50"
          />
        )}

        {!recording && (
          <button
            onClick={startRecording}
            disabled={disabled}
            title="Record a voice note"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ink-700 text-mist-300 hover:border-ink-600 hover:text-mist-100 disabled:opacity-40"
          >
            <Mic size={15} />
          </button>
        )}

        <button
          onClick={submit}
          disabled={disabled || sending || recording || (!text.trim() && !pendingImage)}
          className={clsx(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500 text-[var(--a-on)] transition-colors hover:bg-brand-600 disabled:opacity-40",
          )}
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
}
