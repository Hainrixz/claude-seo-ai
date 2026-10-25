// Portions Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) - see LICENSE for original authors
// SPDX-License-Identifier: MIT
// id: er-d03758e1
export const meta = ({ matches }) => [...matches.flatMap((m) => m.meta ?? []), { title: 'Dashboard' }];
