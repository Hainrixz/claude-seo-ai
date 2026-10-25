// Portions Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) - see LICENSE for original authors
// SPDX-License-Identifier: MIT
// id: er-d03758e1
export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy('css');
  return { dir: { input: 'src', output: '_site' } };
}
