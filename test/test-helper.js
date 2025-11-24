const chai = require('chai');
const chaiHttp = require('chai-http');

// Add chai plugins
chai.use(chaiHttp);

// Make expect available globally
global.expect = chai.expect;

// Helper function to create test server
const createTestServer = async () => {
  // Import server after setting NODE_ENV
  const server = require('../src/server');
  
  // Wait for server to be ready
  await new Promise(resolve => {
    if (server.app.listening) {
      resolve();
    } else {
      server.app.on('listening', resolve);
    }
  });
  
  return server;
};

// Helper function to close test server
const closeTestServer = async (server) => {
  if (server && server.close) {
    await new Promise(resolve => server.close(resolve));
  }
};

module.exports = {
  createTestServer,
  closeTestServer
};
