export const metadata = { title: 'Post' };

export default function Page({ params }) { return <article><h1>{params.slug}</h1></article>; }
