export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy('css');
  return { dir: { input: 'src', output: '_site' } };
}
