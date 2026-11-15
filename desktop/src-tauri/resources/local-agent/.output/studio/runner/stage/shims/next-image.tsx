export default function Image({
  src,
  alt = '',
  fill,
  priority: _p,
  quality: _q,
  placeholder: _ph,
  blurDataURL: _b,
  loader: _l,
  unoptimized: _u,
  ...rest
}: any) {
  const url = typeof src === 'string' ? src : src?.src
  return (
    <img
      src={url}
      alt={alt}
      {...rest}
      style={{ ...(fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } : {}), ...rest.style }}
    />
  )
}
