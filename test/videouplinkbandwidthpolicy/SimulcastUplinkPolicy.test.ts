// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as chai from 'chai';

import LogLevel from '../../src/logger/LogLevel';
import NoOpLogger from '../../src/logger/NoOpLogger';
import {
  SdkBitrate,
  SdkBitrateFrame,
  SdkIndexFrame,
  SdkStreamAllocation,
  SdkStreamDescriptor,
  SdkStreamMediaType,
  SdkSubscribeAckFrame,
  SdkTrackMapping,
} from '../../src/signalingprotocol/SignalingProtocol.js';
import SimulcastTransceiverController from '../../src/transceivercontroller/SimulcastTransceiverController';
import SimulcastVideoStreamIndex from '../../src/videostreamindex/SimulcastVideoStreamIndex';
import SimulcastUplinkPolicy from '../../src/videouplinkbandwidthpolicy/SimulcastUplinkPolicy';
import VideoUplinkBandwidthPolicy from '../../src/videouplinkbandwidthpolicy/VideoUplinkBandwidthPolicy';

describe('SimulcastUplinkPolicy', () => {
  const expect: Chai.ExpectStatic = chai.expect;
  const assert: Chai.AssertStatic = chai.assert;
  const logger = new NoOpLogger(LogLevel.DEBUG);
  interface DateNow {
    (): number;
  }
  let originalDateNow: DateNow;
  let startTime: number;
  const selfAttendeeId = 'self-cb7cb43b';
  let policy: VideoUplinkBandwidthPolicy;

  function mockDateNow(): number {
    return startTime;
  }

  function incrementTime(addMs: number): void {
    startTime += addMs;
  }

  function updateIndexFrame(index: SimulcastVideoStreamIndex, clientCount: number): void {
    const sources: SdkStreamDescriptor[] = [];
    for (let i = 3; i < clientCount + 3; i++) {
      const attendee = i === 0 ? selfAttendeeId : `attendee-${i}`;
      sources.push(
        new SdkStreamDescriptor({
          streamId: 2 * i - 1,
          groupId: i,
          maxBitrateKbps: 100,
          attendeeId: attendee,
          mediaType: SdkStreamMediaType.VIDEO,
        })
      );
      sources.push(
        new SdkStreamDescriptor({
          streamId: 2 * i,
          groupId: i,
          maxBitrateKbps: 200,
          attendeeId: attendee,
          mediaType: SdkStreamMediaType.VIDEO,
        })
      );
    }
    index.integrateIndexFrame(new SdkIndexFrame({ sources: sources }));
  }

  beforeEach(() => {
    startTime = Date.now();
    originalDateNow = Date.now;
    Date.now = mockDateNow;
    policy = new SimulcastUplinkPolicy(selfAttendeeId, logger);
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  describe('constructor', () => {
    it('can be constructed', () => {
      assert.exists(policy);
    });

    it('initializes default uplink parameter', () => {
      const constraint = policy.chooseMediaTrackConstraints();
      expect(JSON.stringify(constraint.frameRate)).to.equal(
        JSON.stringify({ ideal: SimulcastUplinkPolicy.defaultMaxFrameRate })
      );
      expect(JSON.stringify(constraint.width)).to.equal(JSON.stringify({ ideal: 1280 }));
      expect(JSON.stringify(constraint.height)).to.equal(JSON.stringify({ ideal: 768 }));
      const encodingParameter = policy.chooseEncodingParameters();
      expect(encodingParameter.has(SimulcastTransceiverController.MID_LEVEL_NAME)).to.equal(true);
      expect(encodingParameter.has(SimulcastTransceiverController.HIGH_LEVEL_NAME)).to.equal(true);
    });
  });

  describe('updateConnectionMetric', () => {
    it('ignore uplink estimate during startup period', () => {
      policy.updateConnectionMetric({ uplinkKbps: NaN });
      policy.updateConnectionMetric({});
      policy.updateConnectionMetric({ uplinkKbps: 0 });
      policy.updateConnectionMetric({ uplinkKbps: 2000 });
      // Startup period
      // @ts-ignore
      expect(policy.lastUplinkBandwidthKbps).to.equal(1200);
      incrementTime(6100);
      policy.updateConnectionMetric({ uplinkKbps: 2000 });
      // @ts-ignore
      expect(policy.lastUplinkBandwidthKbps).to.equal(2000);
    });

    it('Send Mid and Low res', () => {
      const index = new SimulcastVideoStreamIndex(logger);
      let encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 2);
      policy.updateIndex(index);
      policy.updateConnectionMetric({ uplinkKbps: 2000 });
      encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      incrementTime(6100);
      policy.updateConnectionMetric({ uplinkKbps: 600 });
      let shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(true);
      encodingParams = policy.chooseEncodingParameters();
      let param = encodingParams.get(SimulcastTransceiverController.MID_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(600000);
      param = encodingParams.get(SimulcastTransceiverController.HIGH_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(0);
      incrementTime(6100);
      policy.updateConnectionMetric({ uplinkKbps: 230 });
      shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(true);
    });

    it('Send Mid and Low res at low rate', () => {
      const index = new SimulcastVideoStreamIndex(logger);
      let encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 2);
      policy.updateIndex(index);
      policy.updateConnectionMetric({ uplinkKbps: 2000 });
      encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      incrementTime(6100);
      policy.updateConnectionMetric({ uplinkKbps: 200 });
      let shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(true);
      encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      incrementTime(8100);
      policy.updateConnectionMetric({ uplinkKbps: 310 });
      shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(true);
      encodingParams = policy.chooseEncodingParameters();
      let param = encodingParams.get(SimulcastTransceiverController.MID_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(600000);
      param = encodingParams.get(SimulcastTransceiverController.LOW_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(150000);
    });

    it('Send only low res when bitrate low', () => {
      const index = new SimulcastVideoStreamIndex(logger);
      let encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 2);
      policy.updateIndex(index);
      policy.updateConnectionMetric({ uplinkKbps: 2000 });
      encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      incrementTime(6100);
      policy.updateConnectionMetric({ uplinkKbps: 200 });
      let shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(true);
      encodingParams = policy.chooseEncodingParameters();
      const param = encodingParams.get(SimulcastTransceiverController.LOW_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(300000);
      incrementTime(8100);
      policy.updateConnectionMetric({ uplinkKbps: 280 });
      shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(false);
    });
  });

  describe('encoding change with num clients', () => {
    it('encoding for 1 to 4', () => {
      const index = new SimulcastVideoStreamIndex(logger);
      let encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 14);
      policy.updateIndex(index);
      encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 3);
      policy.updateIndex(index);
      const shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(true);
      encodingParams = policy.chooseEncodingParameters();
      let param = encodingParams.get(SimulcastTransceiverController.LOW_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(300000);
      param = encodingParams.get(SimulcastTransceiverController.HIGH_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(1200000);
    });

    it('encoding for 5 to 6', () => {
      const index = new SimulcastVideoStreamIndex(logger);
      updateIndexFrame(index, 6);
      policy.updateIndex(index);
      let encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 1);
      policy.updateIndex(index);
      encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 5);
      policy.updateIndex(index);
      const shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(true);
      encodingParams = policy.chooseEncodingParameters();
      let param = encodingParams.get(SimulcastTransceiverController.LOW_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(200000);
      param = encodingParams.get(SimulcastTransceiverController.MID_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(600000);
    });

    it('encoding for more than 6', () => {
      const index = new SimulcastVideoStreamIndex(logger);
      let encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 1);
      policy.updateIndex(index);
      encodingParams = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(encodingParams.values()));
      updateIndexFrame(index, 8);
      policy.updateIndex(index);
      const shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(true);
      encodingParams = policy.chooseEncodingParameters();
      let param = encodingParams.get(SimulcastTransceiverController.LOW_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(200000);
      param = encodingParams.get(SimulcastTransceiverController.MID_LEVEL_NAME);
      expect(param.maxBitrate).to.equal(350000);
    });
  });
  describe('updateIndex', () => {
    it('detects webrtc disabled stream', () => {
      const index = new SimulcastVideoStreamIndex(logger);
      updateIndexFrame(index, 2);
      let param = policy.chooseEncodingParameters();

      index.integrateUplinkPolicyDecision(Array.from(param.values()));

      const subackFrame = new SdkSubscribeAckFrame({
        tracks: [
          new SdkTrackMapping({ streamId: 1, trackLabel: 'b18b9db2' }),
          new SdkTrackMapping({ streamId: 2, trackLabel: '4107' }),
          new SdkTrackMapping({ streamId: 3, trackLabel: '9318' }),
        ],
        allocations: [
          new SdkStreamAllocation({
            trackLabel: '',
            streamId: 1,
            groupId: 1,
          }),
          new SdkStreamAllocation({
            trackLabel: '',
            streamId: 2,
            groupId: 1,
          }),
          new SdkStreamAllocation({
            trackLabel: '',
            streamId: 3,
            groupId: 1,
          }),
        ],
      });

      index.integrateSubscribeAckFrame(subackFrame);

      policy.updateIndex(index);
      const shouldResub = policy.wantsResubscribe();
      expect(shouldResub).to.equal(false);
      const mediaConstraint = policy.chooseMediaTrackConstraints();
      param = policy.chooseEncodingParameters();
      index.integrateUplinkPolicyDecision(Array.from(param.values()));
      expect(JSON.stringify(mediaConstraint.height)).to.equal(JSON.stringify({ ideal: 768 }));
      expect(policy.wantsResubscribe()).to.equal(false);
      policy.chooseEncodingParameters();

      let bitrates = SdkBitrateFrame.create();
      let bitrate = SdkBitrate.create();
      bitrate.sourceStreamId = 1;
      bitrate.avgBitrateBps = 200000;
      bitrates.bitrates.push(bitrate);
      bitrate = SdkBitrate.create();
      bitrate.sourceStreamId = 3;
      bitrate.avgBitrateBps = 800000;
      bitrates.bitrates.push(bitrate);
      index.integrateBitratesFrame(bitrates);
      updateIndexFrame(index, 2);
      policy.updateIndex(index);
      incrementTime(6000);
      bitrates = SdkBitrateFrame.create();
      bitrate = SdkBitrate.create();
      bitrate.sourceStreamId = 1;
      bitrate.avgBitrateBps = 200000;
      bitrates.bitrates.push(bitrate);
      index.integrateBitratesFrame(bitrates);
      incrementTime(6000);
      index.integrateBitratesFrame(new SdkBitrateFrame({}));
      expect(policy.wantsResubscribe()).to.equal(true);
    });
  });

  describe('setHasBandwidthPriority', () => {
    it('is no-op', () => {
      policy.setHasBandwidthPriority(true);
    });
  });

  describe('setIdeaMaxBandwidthKbps', () => {
    it('is no-op', () => {
      policy.setIdealMaxBandwidthKbps(1000);
    });
  });

  describe('chooseCaptureAndEncodeParameters', () => {
    it('is no-op', () => {
      policy.chooseCaptureAndEncodeParameters();
    });
  });
});
