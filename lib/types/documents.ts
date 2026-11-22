// Canonical Documents CMS contracts (the sole CMS engine post-Phase 1.1).

import type { BrandTokens } from "./tenant";

export type DocumentType =
  | "home"
  | "header"
  | "footer"
  | "announcement"
  | "design"
  | "collections_index"
  | "product_layout"
  | "collection_layout"
  | "cart"
  | "page"
  | "campaign"
  | "journal"
  | "journal_index"
  | "product_content"
  | "collection_content";

export type IssueSeverity = "error" | "incomplete" | "warning";

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  sectionId?: string | null;
  field?: string | null;
  anchor?: string | null;
}

export interface SectionInstance {
  id: string;
  kind: string;
  v?: number;
  enabled?: boolean;
  settings: Record<string, unknown>;
  /** Phase 3+: optional nested child blocks (e.g. testimonial cards, slides, feature tiles) */
  blocks?: BlockInstance[];
}

export interface BlockInstance {
  id: string;
  type: string;
  enabled?: boolean;
  settings: Record<string, unknown>;
}

export interface DocumentMeta {
  slug?: string | null;
  title?: string;
  description?: string;
  og_image?: { media: string; alt?: string } | null;
  window_start?: string | null;
  window_end?: string | null;
  effective_at?: string | null;
  redirect_from?: string | null;
  noindex?: boolean;
}

export interface DesignDocumentSettings {
  brand?: BrandTokens | null;
  theme?: {
    kit?: string;
    version?: number;
    applied_at?: string;
    /** Phase 2+: active open-engine theme package settings overrides */
    packageId?: string;
    packageVersion?: string;
    customSettings?: Record<string, unknown>;
  } | null;
  logo?: {
    media: string;
    alt?: string;
  } | null;
}

export interface DocumentBody {
  schema: number;
  type: DocumentType;
  meta?: DocumentMeta;
  settings?: Record<string, unknown>;
  sections?: SectionInstance[];
}

export interface DocumentRow {
  id: string;
  type: DocumentType;
  slug: string | null;
  entityId: string | null;
  label: string;
  body: DocumentBody;
  draftHash: string;
  revision: number;
  schemaVersion: number;
  publishedVersionId: string | null;
  publishedHash: string | null;
  undoneVersionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  kind: "checkpoint" | "published" | "kept" | "undo_saved";
  body: DocumentBody;
  bodyHash: string;
  schemaVersion: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ReleaseEntry {
  version: string;
  hash: string;
}

export interface ReleaseListV4 {
  v: 4;
  m: number;
  documents: Record<string, ReleaseEntry | null>;
  pages: Array<{
    document: string;
    slug: string;
    type: "page" | "campaign";
    title?: string;
    enabled?: boolean;
    window_start?: string | null;
    window_end?: string | null;
  }>;
  redirects: Array<{
    document: string;
    from_slug: string;
    to_slug: string;
  }>;
  indexes: {
    journal: ReleaseEntry | null;
  };
}
