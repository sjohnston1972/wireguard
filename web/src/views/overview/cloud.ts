// cloud.ts
//
// Plain English: which cloud the headend is in, and its name for the screen.
// No cloud recorded means Azure (everything before AWS existed).

import type { Cloud, OverviewResponse } from "@shared/api";

export const cloudOf = (o: Pick<OverviewResponse, "snapshot">): Cloud => o.snapshot.cloud ?? "azure";
export const cloudLabel = (c: Cloud): "Azure" | "AWS" => (c === "aws" ? "AWS" : "Azure");
export const cloudFull = (c: Cloud): string => (c === "aws" ? "Amazon Web Services" : "Microsoft Azure");
