import AWS from "aws-sdk"
import { PubSubEngine } from 'graphql-subscriptions'
import { PubSubAsyncIterator } from './async-iterator'
import SQSChannel from "./channel"

export interface PubSubSQSOptions {
    channelName?: string
    client?: AWS.SQS
    region?: string
    channel?: SQSChannel
    delay?: number


    messagePeriod?: number
}

export class SQSPubSub implements PubSubEngine {
    client?: AWS.SQS
    channel: SQSChannel
    private commonMessageHandler: CommonMessageHandler;

    constructor(public options: PubSubSQSOptions = {},
        commonMessageHandler: CommonMessageHandler = message => message) {
        let { channelName, client, region, channel } = options

        if (channel) {
            this.channel = channel
        } else {
            if (!channelName) {
                throw new Error("must have channel name")
            }

            if (region) {
                AWS.config.update({ region })
            }

            if (!client) {
                client = new AWS.SQS({ apiVersion: '2012-11-05' });
            }

            this.client = client
            this.channel = new SQSChannel(channelName, { client: client, commonMessageHandler: commonMessageHandler })
        }

        this.commonMessageHandler = commonMessageHandler;
    }

    public publish<T>(trigger: string, payload: T): Promise<void> {
        return new Promise((resolve) => {
            this.channel.publish(trigger, payload)
            resolve()
        })
    }

    public subscribe(
        trigger: string,
        onMessage: Function,
        options: Object = {},
    ): Promise<number> {
        return this.channel.subscribe(trigger, onMessage, options)
    }

    public unsubscribe(subId: number) {
        this.channel.unsubscribe(subId)
    }

    public asyncIterator<T>(triggers: string | string[], options?: Object): AsyncIterator<T> {
        return new PubSubAsyncIterator<T>(this, triggers, options);
    }

    public close() {
        this.channel.close()
    }
}

export type CommonMessageHandler = (message: any) => any; // Todo: maybe type message
