export async function generateMetadata({ params }) { return { title: (params.slug || ['Docs']).join(' / ') }; }

export default function Page() { return <main><h1>Docs</h1></main>; }
