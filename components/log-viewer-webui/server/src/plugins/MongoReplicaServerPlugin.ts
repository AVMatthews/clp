import {FastifyInstance} from "fastify";
import {Server as HttpServer} from "http";
import {
    Db,
    MongoClient,
    MongoServerError,
} from "mongodb";
import {
    Server,
    Socket,
} from "socket.io";

import MongoReplicaServerCollection from "./MongoReplicaServerCollection.js";


// TODO: Move Initialization and delete from this file before merge
/**
 * Initialize the MongoDB replica set.
 *
 * @param fastify
 * @return
 * @throws {Error} If the replica set initialization fails.
 */
const initializeReplicaSet = async (fastify: FastifyInstance): Promise<void> => {
    try {
        const directMongoClient = new MongoClient(
            "mongodb://localhost:27017",
            {replicaSet: "rs0", directConnection: true}
        );
        const response = await directMongoClient.db("admin").admin()
            .command({replSetInitiate: {}});

        fastify.log.info("Replica set initialized:", response);
    } catch (e) {
        if (e instanceof MongoServerError && "AlreadyInitialized" === e.codeName) {
            return;
        }
        throw new Error("Failed to initialize replica set", {cause: e});
    }
};

interface CollectionInitPayload {
    collectionName: string;
}

class MongoReplicaServer {
    private fastify: FastifyInstance;

    private collections: Map<string, MongoReplicaServerCollection>;

    private mongoDb: Db;


    constructor ({fastify, mongoDb}: {fastify: FastifyInstance; mongoDb: Db}) {
        this.fastify = fastify;
        this.collections = new Map();
        this.mongoDb = mongoDb;
        this.#initializeSocketServer(fastify.server);
    }

    static async create ({
        fastify,
        database,
        host,
        port,
    }: {
        fastify: FastifyInstance;
        database: string;
        host: string;
        port: string;
    }): Promise<MongoReplicaServer> {
        const mongoDb = await MongoReplicaServer.initializeMongoClient({database, host, port});

        return new MongoReplicaServer({fastify, mongoDb});
    }

    static async initializeMongoClient (
        {database, host, port}: {database: string; host: string; port: string}
    ): Promise<Db> {
        const mongoUri = `mongodb://${host}:${port}`;
        const mongoClient = new MongoClient(mongoUri);
        try {
            await mongoClient.connect();

            return mongoClient.db(database);
        } catch (e) {
            throw new Error("MongoDB connection error", {cause: e});
        }
    }

    #getCollectionInitListener (socket: Socket) {
        return async (payload: CollectionInitPayload) => {
            const {collectionName} = payload;
            this.fastify.log.info(`Collection name ${collectionName} requested`);

            let collection = this.collections.get(collectionName);
            if ("undefined" === typeof collection) {
                collection = new MongoReplicaServerCollection(
                    this.mongoDb,
                    collectionName
                );
                this.collections.set(collectionName, collection);
            }
            collection.refAdd();

            socket.data = {collectionName};
        };
    }

    #getCollectionDisconnectListener (socket: Socket) {
        return () => {
            this.fastify.log.info(`Socket disconnected: ${socket.id}`);
            const {collectionName} = socket.data as {collectionName: string};
            const collection = this.collections.get(collectionName);
            if ("undefined" !== typeof collection) {
                collection.refRemove();
                if (!collection.isReferenced()) {
                    this.fastify.log.info(`Collection ${collectionName} removed`);
                    this.collections.delete(collectionName);
                }
            }
        };
    }

    #getCollectionFindToArrayListener (socket: Socket) {
        return async (
            {query, options}: {query: object; options: object},
            callback
        ) => {
            const {collectionName} = socket.data as {collectionName: string};
            const collection = this.collections.get(collectionName);

            if ("undefined" === typeof collection) {
                return callback({
                    error: "Collection not initialized",
                });
            }

            const documents = await collection.find(query, options).toArray();

            return callback({data: documents});
        };
    }

    #getCollectionFindToReactiveArrayListener (socket: Socket) {
        return async (
            {query, options}: {query: object; options: object},
            callback: any
        ) => {
            const {collectionName} = socket.data as {collectionName: string};
            this.fastify.log.info(
                `Collection name ${collectionName} requested subscription`
            );
            const collection = this.collections.get(collectionName);

            if ("undefined" === typeof collection) {
                return callback({
                    error: "Collection not initialized",
                });
            }

            const {queryHash, watcher} = collection.getWatcher(query, options);
            callback({queryHash});
            watcher.on("change", async () => {
            // eslint-disable-next-line no-warning-comments
            // FIXME: this should be debounced
                socket.emit("collection::find::update", {
                    data: await collection.find(query, options).toArray(),
                });
            });

            socket.emit("collection::find::update", {
                data: await collection.find(query, options).toArray(),
            });
        };
    }

    #getCollectionFindUnsubscribeListener (socket: Socket) {
        return ({queryHash}: {queryHash: string}) => {
            const {collectionName} = socket.data as {collectionName: string};
            this.fastify.log.info(`Collection name ${collectionName} requested unsubscription`);
            const collection = this.collections.get(collectionName);

            if ("undefined" === typeof collection) {
                return;
            }

            collection.removeWatcher(queryHash);
        };
    }

    #initializeSocketServer (httpServer: HttpServer) {
        const io = new Server(httpServer);

        io.on("connection", (socket) => {
            this.fastify.log.info(`Socket connected: ${socket.id}`);
            ([
                {
                    event: "collection::init",
                    listener: this.#getCollectionInitListener(socket),
                },
                {
                    event: "disconnect",
                    listener: this.#getCollectionDisconnectListener(socket),
                },
                {
                    event: "collection::find::toArray",
                    listener: this.#getCollectionFindToArrayListener(socket),
                },
                {
                    event: "collection::find::toReactiveArray",
                    listener: this.#getCollectionFindToReactiveArrayListener(socket),
                },
                {
                    event: "collection::find::unsubscribe",
                    listener: this.#getCollectionFindUnsubscribeListener(socket),
                },
            ]).forEach(({event, listener}) => {
                socket.on(event, listener);
            });
        });
    }
}

/**
 * MongoDB replica set plugin for Fastify.
 *
 * @param app
 * @param options
 * @param options.database
 * @param options.host
 * @param options.port
 */
const MongoReplicaServerPlugin = async (
    app: FastifyInstance,
    options: {host: string; port: number; database: string}
) => {
    // FIXME: remove below
    await initializeReplicaSet(app);

    app.decorate(
        "MongoReplicaServer",
        MongoReplicaServer.create({
            fastify: app,
            host: options.host,
            port: options.port.toString(),
            database: options.database,
        })
    );
};


export default MongoReplicaServerPlugin;
