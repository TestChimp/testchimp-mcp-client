export function normalizeScope(scope: {
  filePaths?: string[];
  folderPath?: string[] | string;
}): { filePaths?: string[]; folderPath?: string[] } {
  let folderPath: string[] | undefined;
  if (Array.isArray(scope.folderPath)) {
    folderPath = scope.folderPath;
  } else if (typeof scope.folderPath === "string" && scope.folderPath.trim() !== "") {
    folderPath = scope.folderPath
      .split("/")
      .map((seg) => seg.trim())
      .filter(Boolean);
  }
  const out: { filePaths?: string[]; folderPath?: string[] } = {};
  if (scope.filePaths?.length) out.filePaths = scope.filePaths;
  if (folderPath) out.folderPath = folderPath;
  return out;
}
