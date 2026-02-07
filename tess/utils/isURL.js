/**
 * Loosely validate a URL `string`.
 * Logic copied from `is-url` package.
 * https://github.com/segmentio/is-url/blob/master/index.js
 *
 * @param {String} string
 */
export default (string) => {
  const protocolAndDomainRE = /^(?:\w+:)?\/\/(\S+)$/;
  const localhostDomainRE = /^localhost[:?\d]*(?:[^:?\d]\S*)?$/;
  const nonLocalhostDomainRE = /^[^\s.]+\.\S{2,}$/;

  if (typeof string !== 'string') {
    return false;
  }

  const match = string.match(protocolAndDomainRE);
  if (!match) {
    return false;
  }

  const everythingAfterProtocol = match[1];
  if (!everythingAfterProtocol) {
    return false;
  }

  if (localhostDomainRE.test(everythingAfterProtocol)
      || nonLocalhostDomainRE.test(everythingAfterProtocol)) {
    return true;
  }

  return false;
};
