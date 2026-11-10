# Third-party notices

`App/Resources/EveBotAvatar.html` is a bundle exported from the website's bot renderer.
Besides Native Intelligence's own code it contains these packages, both under the MIT License:

- **bot-avatars** 0.1.1, Copyright (c) 2026 Jakub Antalik
  (https://github.com/Jakubantalik/Libraries.dev, `packages/bot-avatars`)
- **React**, Copyright (c) Meta Platforms, Inc. and affiliates

The MIT License text for both:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The Swift packages the app depends on (supabase-swift, posthog-ios, swift-markdown-ui
and their dependencies) aren't copied into this repo; Xcode fetches them, each with its
own license.
