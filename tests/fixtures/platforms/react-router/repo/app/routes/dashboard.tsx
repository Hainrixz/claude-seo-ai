export const meta = ({ matches }) => [...matches.flatMap((m) => m.meta ?? []), { title: 'Dashboard' }];
