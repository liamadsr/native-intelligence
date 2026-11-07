import { clsx } from 'clsx'

export function Gradient({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      {...props}
      className={clsx(
        className,
        'backdrop-blur-xl backdrop-saturate-150',
      )}
      style={{
        background: 'linear-gradient(145deg, \
          #f8fafc 0%, \
          #94a3b8 30%, \
          #475569 60%, \
          #1e293b 90%, \
          #0f172a 100%)',
      }}
    />
  )
}

export function GradientBackground() {
  return (
    <div className="relative mx-auto max-w-7xl">
      <div
        className={clsx(
          'absolute -right-60 -top-44 h-60 w-xl transform-gpu md:right-0',
          'rotate-[-10deg] rounded-full blur-3xl',
          'backdrop-blur-xl backdrop-saturate-150',
        )}
        style={{
          background: 'linear-gradient(145deg, \
            #f8fafc 0%, \
            #94a3b8 30%, \
            #475569 60%, \
            #1e293b 90%, \
            #0f172a 100%)',
        }}
      />
    </div>
  )
}
