export type FileType =
  | "code"
  | "document"
  | "paper"
  | "image"
  | "video"
  | "rationale"
  | "concept"
  | "dependency";

export type Confidence = "EXTRACTED" | "STATIC_RESOLVED" | "INFERRED" | "AMBIGUOUS";

export type EvidenceSource = "ast" | "lsp" | "regex" | "llm";

export interface GraphNode {
  id: string;
  label: string;
  file_type: FileType;
  source_file: string;
  source_location?: string | null;
  community?: number;
  norm_label?: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: Confidence;
  source_file: string;
  source_location?: string | null;
  weight?: number;
  context?: string;
  confidence_score?: number;
  _src?: string;
  _tgt?: string;
  [key: string]: unknown;
}

export interface Hyperedge {
  id: string;
  label: string;
  nodes: string[];
  confidence?: Confidence;
  confidence_score?: number;
  [key: string]: unknown;
}

export interface RawCall {
  caller_nid: string;
  callee: string;
  source_file: string;
  source_location?: string | null;
  is_member_call?: boolean;
  call_site_nid?: string;
}

export interface Extraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hyperedges?: Hyperedge[];
  raw_calls?: RawCall[];
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
  [key: string]: unknown;
}

export interface DetectionResult {
  files: Record<"code" | "document" | "paper" | "image" | "video", string[]>;
  total_files: number;
  total_words: number;
  needs_graph: boolean;
  warning?: string | null;
  skipped_sensitive: string[];
  graphifyignore_patterns: number;
  incremental?: boolean;
  new_files?: Record<"code" | "document" | "paper" | "image" | "video", string[]>;
  unchanged_files?: Record<"code" | "document" | "paper" | "image" | "video", string[]>;
  new_total?: number;
  deleted_files?: string[];
}

export interface GodNode {
  id: string;
  label: string;
  degree: number;
}

export interface Surprise {
  source: string;
  target: string;
  source_files: [string, string];
  confidence: Confidence;
  relation: string;
  why?: string;
  note?: string;
  confidence_score?: number;
}

export interface SuggestedQuestion {
  question?: string;
  why: string;
  type?: string;
}

export interface NodeLinkGraph {
  directed: boolean;
  multigraph: boolean;
  graph: Record<string, unknown>;
  nodes: GraphNode[];
  links: GraphEdge[];
  hyperedges?: Hyperedge[];
}
