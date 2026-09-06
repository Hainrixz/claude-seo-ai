import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('about', 'routes/about.tsx'),
  layout('routes/shell.tsx', [
    ...prefix('blog', [
      index('routes/blog/index.tsx'),
      route(':slug', 'routes/blog/post.tsx'),
    ]),
  ]),
] satisfies RouteConfig;
