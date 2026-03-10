import { Context, Effect } from "effect";
import type { AppError } from "../app/errors.js";

export interface NotificationPayload {
  readonly title: string;
  readonly severity: "warn" | "error" | "info";
  readonly dedupeKey: string;
  readonly slug?: string;
  readonly conditionId?: string;
  readonly upTokenId?: string;
  readonly downTokenId?: string;
  readonly details: Array<{ key: string; value: string | number | null | undefined }>;
}

export interface Notifications {
  readonly send: (payload: NotificationPayload) => Effect.Effect<void, AppError>;
}

export const Notifications = Context.GenericTag<Notifications>("ports/Notifications");
