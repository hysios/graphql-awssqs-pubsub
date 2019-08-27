import * as AWS from "aws-sdk"
import { EventEmitter } from "events"
import minimatch from "minimatch"
import { CommonMessageHandler } from "./sqs-pubsub";


interface ChannelOptions {
    client?: AWS.SQS
    delay?: number
    waitSeconds?: number
    messagePeriod?: number
    commonMessageHandler?: CommonMessageHandler
}

type Matcher = [number, MatcherFunction]

interface MatcherFunction {
    (topic: string): Function | undefined
}

class SQSChannel extends EventEmitter {
    client: AWS.SQS
    private queueUrl?: string
    private subscriptionMap: { [subId: number]: [string, Function] };
    private subsRefsMap: { [topic: string]: Array<number> };
    private patternSubscriptions: Matcher[] = []
    private currentSubscriptionId: number;
    commonMessageHandler: CommonMessageHandler

    defaultOptions = {
        delay: 0,
        messagePeriod: 86400,
        waitSeconds: 0
    }
    // private psubscriptions: PSubscrible
    private subscriptions: {
        [topic: string]: Function[]
    }

    constructor(public name: string, public options: ChannelOptions = {}) {
        super()
        let { client, commonMessageHandler } = options
        this.options = Object.assign({}, this.defaultOptions, options)

        if (!client) {
            client = new AWS.SQS({ apiVersion: '2012-11-05' });
        }
        this.subscriptionMap = {}
        this.subsRefsMap = {}
        this.currentSubscriptionId = 0
        this.client = client
        if (!commonMessageHandler) {
            commonMessageHandler = (message) => message
        }

        this.commonMessageHandler = commonMessageHandler
    }

    private ensure(): Promise<this> {
        if (this.queueUrl) {
            return Promise.resolve(this)
        }

        let params = {
            QueueName: this.name,
            Attributes: {
                'DelaySeconds': String(this.options.delay),
                'MessageRetentionPeriod': String(this.options.messagePeriod)
            }
        }

        return new Promise((resolve, reject) => {
            this.client.createQueue(params, (err, data) => {
                if (err) {
                    reject(err)
                } else {
                    this.queueUrl = data.QueueUrl
                    resolve(this)
                }
            })
        })
    }

    subscribe(topic: string, OnMessage: Function, options: any = {}): Promise<number> {
        let { pattern } = options
        return new Promise((resolve, reject) => {
            this.ensure().then(() => {
                this.listener2()
                const id = pattern ? this.pushMatch(topic, OnMessage) : this.pushRef(topic, OnMessage)
                console.log('subscribe', id)
                resolve(id)
            }).catch(reject)
        })
    }

    private deleteRef(topicId: number) {
        if (!this.subscriptionMap[topicId]) {
            throw new Error(`There is no subscription of id "${topicId}"`)
        }

        const [topic, _] = this.subscriptionMap[topicId]
        const idx = this.subsRefsMap[topic].indexOf(topicId)
        const refs = this.subsRefsMap[topic]
        const prefs = this.patternSubscriptions

        this.subsRefsMap[topic] = refs.slice(0, idx).concat(refs.slice(idx + 1))
        delete this.subscriptionMap[topicId]
        for (let i = 0; i < prefs.length; i++) {
            let [id, _] = prefs[i]
            if (id === topicId) {
                this.patternSubscriptions = prefs.slice(0, i).concat(prefs.slice(i + 1))
                break
            }
        }
    }

    private pushRef(topic: string, onMessage: Function): number {
        const id = this.currentSubscriptionId++;
        this.subscriptionMap[id] = [topic, onMessage];
        const refs = this.subsRefsMap[topic] || [];
        refs.push(id)
        this.subsRefsMap[topic] = refs
        return id
    }

    private pushMatch(pattern: string, onMessage: Function): number {
        const id = this.currentSubscriptionId++;
        this.subscriptionMap[id] = [pattern, onMessage];
        this.patternSubscriptions.push([id, (topic: string): Function => {
            if (minimatch(topic, pattern)) {
                return onMessage
            }
        }])

        return id
    }

    private getRef(topic: string): Function {
        const refs = this.subsRefsMap[topic] || []
        return ((msg) => {
            for (let id of refs) {
                const [_, OnMessage] = this.subscriptionMap[id]
                OnMessage(msg)
            }
        })
    }

    private matchRef(topic: string): Function {
        for (let [_, matcher] of this.patternSubscriptions) {
            let ref = matcher(topic)
            if (ref) {
                return ref
            }
        }

        return this.getRef(topic)
    }

    public unsubscribeAll(topic: string) {
        delete this.subscriptions[topic]
    }

    public unsubscribe(subId: number) {
        this.deleteRef(subId)
    }

    public publish(topic: string, payload: any): Promise<string> {

        return new Promise((resolve, reject) => {
            this.ensure().then(() => {
                let params = {
                    DelaySeconds: 0,
                    MessageAttributes: {
                        Topic: {
                            DataType: "String",
                            StringValue: topic
                        },
                    },
                    MessageBody: JSON.stringify(payload),
                    QueueUrl: this.queueUrl!
                };

                this.client.sendMessage(params, (err, data) => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve(data.MessageId)
                    }
                });
            })
        })
    }

    public close() {
        this.running = false
    }

    public receiveMessage(options = { waitSeconds: 0 }): Promise<AWS.SQS.MessageList> {
        options = Object.assign({}, this.options, options)

        let params: AWS.SQS.ReceiveMessageRequest = {
            AttributeNames: [
                "SentTimestamp",
                "Topic",
                "BodyType",
            ],
            MaxNumberOfMessages: 10,
            MessageAttributeNames: [
                "All"
            ],
            QueueUrl: this.queueUrl,
            VisibilityTimeout: 20,
            WaitTimeSeconds: options.waitSeconds
        };

        return new Promise((resolve, reject) => {
            this.client.receiveMessage(params, (err, data) => {
                if (err) {
                    reject(err)
                } else if (data.Messages) {
                    resolve(data.Messages)
                }
            });
        })
    }

    public deleteMessage(handle: string): Promise<any> {
        return new Promise((resolve, reject) => {
            let deleteParams = {
                QueueUrl: this.queueUrl,
                ReceiptHandle: handle
            };

            this.client.deleteMessage(deleteParams, (err, data) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(data)
                }
            });
        })
    }

    private running = false

    waitMessageUtil(duration: number): Promise<AWS.SQS.MessageList> {
        return new Promise((resolve) => {
            this.receiveMessage({ waitSeconds: duration }).then(resolve)
        })
    }

    listener() {
        if (this.running) {
            return Promise.resolve()
        }

        this.running = true

        setImmediate(async () => {

            // while (this.running) {
            let msgs = await this.receiveMessage();

            if (msgs && msgs.length > 0) {
                for (let msg of msgs) {
                    let { MessageAttributes, Body } = msg,
                        topic = MessageAttributes["Topic"] ? MessageAttributes["Topic"].StringValue : undefined;

                    this.onMessage(topic, this.commonMessageHandler(JSON.parse(Body)))
                    await this.deleteMessage(msg.ReceiptHandle)
                }
            }
            this.running = false
            // }
        })
        // return Promise.resolve()
    }

    private listener2(): Promise<void> {
        if (this.running) {
            return Promise.resolve()
        }

        this.running = true

        this.loopMessage()
    }

    loopMessage(options = { waitSeconds: 0 }) {
        const processMessages = (msgs) => {
            (msgs || []).forEach(this.processMsg.bind(this))
        }

        this.rawReceiveMessage(options, (data) => {
            processMessages(data.Messages)
            this.loopMessage(options)
        })
    }

    rawReceiveMessage(options = { waitSeconds: 0 }, callbacks: Function) {
        options = Object.assign({}, this.options, options)

        let params: AWS.SQS.ReceiveMessageRequest = {
            AttributeNames: [
                "SentTimestamp",
                "Topic",
                "BodyType",
            ],
            MaxNumberOfMessages: 10,
            MessageAttributeNames: [
                "All"
            ],
            QueueUrl: this.queueUrl,
            VisibilityTimeout: 20,
            WaitTimeSeconds: options.waitSeconds
        };

        this.client.receiveMessage(params, (err, data) => {
            if (err) {
                console.error(err)
                this.running = false
                return
            } else if (data.Messages) {
                callbacks(data)
                // processMessages(data.Messages)
                // this.loopMessage(options)
            }
        });
    }

    rawDeleteMessage(handle) {
        let deleteParams = {
            QueueUrl: this.queueUrl,
            ReceiptHandle: handle
        };

        this.client.deleteMessage(deleteParams, (err, data) => {
            if (err) {
                console.error(err)
            }
        });
    }

    processMsg(msg) {
        let { MessageAttributes, Body } = msg,
            topic = MessageAttributes["Topic"] ? MessageAttributes["Topic"].StringValue : undefined;

        this.onMessage(topic, this.commonMessageHandler(JSON.parse(Body)))
        this.rawDeleteMessage(msg.ReceiptHandle)
    }

    private onMessage(topic: string | undefined, msg: any) {
        this.matchRef(topic)(msg)
    }
}

export default SQSChannel