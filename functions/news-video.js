'use strict';
const {onObjectFinalized}=require('firebase-functions/v2/storage');
const {getStorage}=require('firebase-admin/storage');
const {createVideoProcessor,eventTarget}=require('./news-video-processing');
const BUCKET='tip-line-8c2d7.firebasestorage.app';
let processVideo;
exports.processNewsVideo=onObjectFinalized({bucket:BUCKET,region:'us-west1',memory:'4GiB',cpu:2,concurrency:1,maxInstances:2,timeoutSeconds:540,retry:true},async event=>{
    if(event.data?.bucket!==BUCKET||!eventTarget(event.data))return;
    processVideo ||= createVideoProcessor({bucket:getStorage().bucket(BUCKET),ffmpeg:require('ffmpeg-static'),ffprobe:require('ffprobe-static').path});
    await processVideo(event.data);
});
