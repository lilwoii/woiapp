export async function saveAccountExport(content: string, fileName: string) {
  if (typeof document === 'undefined') {
    throw new Error('Browser downloads are not available during server rendering.');
  }
  const url = URL.createObjectURL(
    new Blob([content], { type: 'application/json;charset=utf-8' }),
  );
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
