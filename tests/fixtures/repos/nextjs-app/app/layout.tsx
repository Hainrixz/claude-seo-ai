export const metadata = {
  title: { default: 'Ridgeline', template: '%s | Ridgeline' },
};

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
