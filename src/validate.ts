import type { Extraction } from "./types.js";

const validFileTypes = new Set(["code", "document", "paper", "image", "video", "rationale", "concept"]);
const validConfidences = new Set(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);

export function validateExtraction(data: unknown): string[] {
  if (!data || typeof data !== "object") return ["Extraction must be a JSON object"];
  const extraction = data as Partial<Extraction>;
  const errors: string[] = [];

  if (!Array.isArray(extraction.nodes)) {
    errors.push("Missing required list 'nodes'");
  } else {
    extraction.nodes.forEach((node, index) => {
      for (const field of ["id", "label", "file_type", "source_file"] as const) {
        if (!(field in node)) errors.push(`Node ${index} missing required field '${field}'`);
      }
      if ("file_type" in node && !validFileTypes.has(String(node.file_type))) {
        errors.push(`Node ${index} has invalid file_type '${String(node.file_type)}'`);
      }
    });
  }

  if (!Array.isArray(extraction.edges)) {
    errors.push("Missing required list 'edges'");
  } else {
    const nodeIds = new Set((extraction.nodes ?? []).map((node) => node.id));
    extraction.edges.forEach((edge, index) => {
      for (const field of ["source", "target", "relation", "confidence", "source_file"] as const) {
        if (!(field in edge)) errors.push(`Edge ${index} missing required field '${field}'`);
      }
      if ("confidence" in edge && !validConfidences.has(String(edge.confidence))) {
        errors.push(`Edge ${index} has invalid confidence '${String(edge.confidence)}'`);
      }
      if (nodeIds.size > 0 && edge.source && !nodeIds.has(edge.source)) {
        errors.push(`Edge ${index} source '${edge.source}' does not match any node id`);
      }
      if (nodeIds.size > 0 && edge.target && !nodeIds.has(edge.target)) {
        errors.push(`Edge ${index} target '${edge.target}' does not match any node id`);
      }
    });
  }

  return errors;
}
