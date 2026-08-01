import { Alert, Platform } from 'react-native';

export function confirmAction(input: {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  if (Platform.OS === 'web') {
    const browserConfirm = (globalThis as typeof globalThis & {
      confirm?: (message?: string) => boolean;
    }).confirm;
    return Promise.resolve(browserConfirm ? browserConfirm(`${input.title}\n\n${input.message}`) : false);
  }

  return new Promise((resolve) => {
    Alert.alert(input.title, input.message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      {
        text: input.confirmLabel ?? 'Continue',
        style: input.destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}

export function showMessage(title: string, message: string) {
  if (Platform.OS === 'web') {
    const browserAlert = (globalThis as typeof globalThis & {
      alert?: (message?: string) => void;
    }).alert;
    browserAlert?.(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}
