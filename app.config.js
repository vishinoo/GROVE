/**
 * Expo config, with the one value that cannot be written down in advance.
 *
 * Google requires an installed app's OAuth redirect to use a custom URI scheme
 * that IS the client id with its dotted parts reversed. It is not a free
 * choice, `grove://` is rejected, and the scheme has to appear in two places
 * that must agree exactly: this file, which puts it in Info.plist, and
 * googleAuth.ts, which builds the redirect Google is asked to send you back to.
 *
 * A mismatch between them fails at the very last step of the flow — after
 * consent, after the tokens are minted — which is the most confusing place a
 * sign-in can break. So both sides derive it from the same environment
 * variable and neither hardcodes it.
 *
 * Everything else still lives in app.json; this only layers the scheme on top.
 */

const base = require('./app.json');

/** "1234-abc.apps.googleusercontent.com" -> "com.googleusercontent.apps.1234-abc" */
function reversed(clientId) {
  return clientId.split('.').reverse().join('.');
}

module.exports = () => {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '';
  const expo = { ...base.expo };

  if (clientId) {
    expo.ios = {
      ...expo.ios,
      infoPlist: {
        ...expo.ios?.infoPlist,
        CFBundleURLTypes: [
          ...(expo.ios?.infoPlist?.CFBundleURLTypes ?? []),
          { CFBundleURLSchemes: [reversed(clientId)] },
        ],
      },
    };
  }

  return expo;
};
