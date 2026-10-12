const { createFakeMongo } = require('./fake-mongo');

// Loaded only in the disposable server process, to give it an in-memory MongoDB in place
// of the driver. Its data lives and dies with that process. A connection string naming
// unreachable.test is refused, as a server that does not answer would be.
const { FakeMongoClient } = createFakeMongo({
    behavior: {
        connect: connection_string => {
            if (connection_string.includes('unreachable.test')) throw new Error('getaddrinfo ENOTFOUND unreachable.test');
        }
    }
});
require('../../db').setMongoClientCtor(FakeMongoClient);
