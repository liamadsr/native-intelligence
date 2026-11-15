export default function Link({ href, children, prefetch: _p, replace: _r, scroll: _s, ...rest }: any) {
  return (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  )
}
