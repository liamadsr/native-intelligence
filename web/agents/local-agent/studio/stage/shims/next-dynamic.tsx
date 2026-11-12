import React, { Suspense, lazy } from 'react'
// next/dynamic: load the module with React.lazy (no SSR here anyway).
export default function dynamic(loader: () => Promise<any>, options: { loading?: () => React.ReactNode } = {}) {
  const Lazy = lazy(async () => {
    const mod = await loader()
    return { default: (mod && (mod as any).default) || mod }
  })
  return function Dynamic(props: any) {
    return (
      <Suspense fallback={options.loading ? options.loading() : null}>
        <Lazy {...props} />
      </Suspense>
    )
  }
}
