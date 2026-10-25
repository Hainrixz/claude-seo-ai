// Portions Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) - see LICENSE for original authors
// SPDX-License-Identifier: MIT
// id: er-d03758e1
export const metadata = { title: 'Post' };

export default function Page({ params }) { return <article><h1>{params.slug}</h1></article>; }
