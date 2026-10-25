// Portions Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) - see LICENSE for original authors
// SPDX-License-Identifier: MIT
// id: er-d03758e1
export async function generateMetadata({ params }) { return { title: (params.slug || ['Docs']).join(' / ') }; }

export default function Page() { return <main><h1>Docs</h1></main>; }
