// cloud.ts
//
// Plain English: which cloud the headend is in, and its name for the screen.
// No cloud recorded means Azure (everything before AWS existed). The insight
// answers (/api/v1/azure/*) say whose figures they carry the same way: no
// `cloud` field means Azure (AWS insights spec 2026-10-15 section 6).

import type { Cloud, OverviewResponse } from "@shared/api";

export const cloudOf = (o: Pick<OverviewResponse, "snapshot">): Cloud => o.snapshot.cloud ?? "azure";
/** Whose figures an insights answer carries: its `cloud`, else Azure (also while it is still loading). */
export const insightsCloud = (r: { cloud?: Cloud } | null | undefined): Cloud => r?.cloud ?? "azure";
/** The headend's region: what the snapshot recorded, else the configured one of its own cloud (nothing recorded after a tear-down). */
export const regionOf = (o: Pick<OverviewResponse, "snapshot" | "config">): string => o.snapshot.region ?? (cloudOf(o) === "aws" ? o.config.aws.region : o.config.region);
/** The headend's size, the same way: the snapshot's, else its own cloud's configured one. */
export const sizeOf = (o: Pick<OverviewResponse, "snapshot" | "config">): string => o.snapshot.vm_size ?? (cloudOf(o) === "aws" ? o.config.aws.instanceType : o.config.vmSize);
export const cloudLabel = (c: Cloud): "Azure" | "AWS" => (c === "aws" ? "AWS" : "Azure");
export const cloudFull = (c: Cloud): string => (c === "aws" ? "Amazon Web Services" : "Microsoft Azure");
