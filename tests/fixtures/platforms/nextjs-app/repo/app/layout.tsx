export const metadata = {
  title: { default: 'Northwind Cloud', template: '%s | Northwind Cloud' },
};

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
