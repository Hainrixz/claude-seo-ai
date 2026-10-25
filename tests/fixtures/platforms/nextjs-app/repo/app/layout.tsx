// Portions Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) - see LICENSE for original authors
// SPDX-License-Identifier: MIT
// id: er-d03758e1
export const metadata = {
  title: { default: 'Northwind Cloud', template: '%s | Northwind Cloud' },
};

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
