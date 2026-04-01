import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import { Truck } from '@/types/truck';

type Props = {
  trucks: Truck[];
};

export function LiveMap({ trucks }: Props) {
  return (
    <View style={styles.shell}>
      <Text style={styles.title}>Interactive map is enabled in the iPhone build.</Text>
      <View style={styles.list}>
        {trucks.map((truck) => (
          <Text key={truck.id} style={styles.item}>
            {truck.name} - {truck.address}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    backgroundColor: '#E8E1D3',
    gap: 12,
    minHeight: 280,
    padding: 20,
  },
  title: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  list: {
    gap: 10,
  },
  item: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
});
