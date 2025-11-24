const keytar = require('keytar');

async function testKeychain() {
  try {
    const service = 'docfinder-test';
    const account = 'test-account';
    const password = 'test-password';

    console.log('Writing to keychain...');
    await keytar.setPassword(service, account, password);
    console.log('Write successful');

    console.log('Reading from keychain...');
    const result = await keytar.getPassword(service, account);
    console.log('Read successful:', result === password ? 'Password matches' : 'Password mismatch');

    console.log('Deleting from keychain...');
    await keytar.deletePassword(service, account);
    console.log('Delete successful');

  } catch (error) {
    console.error('Keychain test failed:', error);
  }
}

testKeychain().catch(console.error);
