import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function saveAccountExport(content: string, fileName: string) {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('File sharing is not available on this device.');
  }
  const safeFileName =
    fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) ||
    'spottr-account-export.json';
  const exportFile = new File(Paths.cache, safeFileName);
  exportFile.create({ overwrite: true });
  try {
    exportFile.write(content);
    await Sharing.shareAsync(exportFile.uri, {
      dialogTitle: 'Save or share your Spottr account export',
      mimeType: 'application/json',
      UTI: 'public.json',
    });
  } finally {
    if (exportFile.exists) exportFile.delete();
  }
}
