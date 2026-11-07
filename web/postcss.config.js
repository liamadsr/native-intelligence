module.exports = {
  // Built plugins, not names: Vite (vitest) takes only plugins in an array, and
  // Turbopack bundles this file, so a relative plugin path wouldn't resolve.
  plugins: [
    // Required at run time, as Turbopack does for a plugin given by name.
    require(/* turbopackIgnore: true */ '@tailwindcss/postcss')(),
    // After Tailwind: the typography plugin's not-prose check as a class
    // selector (see the file).
    require('./src/styles/postcss/not-prose-class.js')(),
    // After Tailwind: ::before / ::after rules only for the elements that have
    // one (see the file).
    require('./src/styles/postcss/before-after-hosts.js')(),
  ],
}
