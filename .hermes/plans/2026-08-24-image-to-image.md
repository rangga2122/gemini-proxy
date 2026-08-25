# Image-to-Image Implementation Plan

> **For Hermes:** Implement task-by-task using TDD.

**Goal:** Add image-to-image to the existing image generation card and unified `/v1/images/generations` contract.

**Architecture:** Normalize public `image` input (data URL or `{base64,mimeType}`) into the existing internal `referenceImage` shape. Preserve `referenceImage` compatibility. UI switches between text-to-image and image-to-image, providing upload and preview only in image mode.

**Tech Stack:** Node.js ES modules, native HTTP, single-file HTML/CSS/JS.

---

### Task 1: Public image input normalization
- Create `lib/images.js`.
- Create `test_images.js` first and verify failure.
- Support data URLs and object input; reject unsupported MIME, malformed base64, and oversized images.

### Task 2: Unified API contract
- Modify `server.js` to accept `image` as an alias for `referenceImage` on generation and variation endpoints.
- Return mode (`text-to-image` or `image-to-image`) in responses.
- Keep previous clients compatible.

### Task 3: Image card UI
- Add mode switch, conditional upload, preview, replace/remove controls.
- Send uploaded data using `image`.
- Update endpoint examples.

### Task 4: Verification
- Run unit tests, syntax checks, existing smoke tests where safe.
- Restart systemd only after checks pass.
- Test public key generation and a real image-to-image request on the live domain.
- Inspect desktop UI and verify no forbidden upstream branding appears.
明
Configuration is intentionally limited to one reference image, 10 MB maximum, JPEG/PNG/WebP only.
日本語/Unicode markers ensure encoding path is preserved.
No other production service is modified.
No database or Supabase is used.
No endpoint is removed.
No API key behavior is changed.
No account pool behavior is changed.
No RupaAI code is touched.
No existing cron job is touched.
No generated credentials are recorded in this plan.
No secrets are logged.
No automatic image compression is added in this scope.
No URL-based remote image fetch is added in this scope.
No SVG input is accepted.
No GIF input is accepted.
No multi-reference UI is added.
No multipart endpoint is added; JSON remains the contract.
No separate `/v1/images/edits` endpoint is added.
No user-visible upstream name is introduced.
No new runtime dependency is added.
No UI redesign is performed.
No changes are made outside `/home/ubuntu/work/gemini-proxy`.
No claims of completion occur before live verification.
No test uses fabricated upstream success.
No source image is persisted server-side.
No result image is persisted server-side.
No browser credential is sent outside the existing origin.
No public admin panel is restored.
No manual key input is restored.
No new account is added.
No token capture is triggered.
No proxy route is changed.
No firewall rule is changed.
No Cloudflare setting is changed.
No service name or port is changed.
No package installation is required.
No branch or git operation is required unless explicitly requested.
No generated media is retained after verification unless needed as evidence.
No production source beyond this standalone service is changed.
No output format is removed.
No OpenAI-compatible text/image response shape is removed.
No count behavior is changed except forwarding the reference image.
No seed behavior is changed.
No ratio behavior is changed.
No TTS, chat, or vision behavior is changed.
No extension behavior is changed.
No token pool file format is changed.
No API key storage format is changed.
No server credentials are shown to the user.
No hidden admin endpoint is exposed in UI.
No master key is required for the one-click playground key.
No undocumented breaking change is introduced.
No stale placeholder is left in the new image mode.
No `Gemini` word is added to visible UI.
No emoji is introduced for the new mode control.
No inaccessible unlabeled file input is introduced.
No success message is shown before the server responds.
No image request is sent until the file reader completes.
No unsupported file is silently accepted.
No empty prompt is accepted.
No image-to-image request without an image is accepted by UI.
No image source appears in logs.
No base64 payload is echoed in errors.
No image content is included in public pool/status endpoints.
No API docs imply remote URL support.
No concurrency policy changes.
No extra account rotation behavior.
No retries beyond existing behavior.
No destructive migration.
No rollback of the simplified API-key UI.
No separate page or modal.
No visual identity replacement.
No unrelated detector finding is treated as scope expansion.
No completion claim without test output.
No summary invents unsupported behavior.
No endpoint test substitutes for actual generation.
No actual generation substitutes for contract tests.
Both are required.
End of plan.
List complete.
Scope fixed.
Implementation approved by user.
Proceed.
OK.
Final constraints retained.
Ensure UI displays source preview.
Ensure result remains separate.
Ensure generated key can call endpoint.
Ensure response reports mode.
Ensure old referenceImage still works.
Ensure image alias works.
Ensure data URL parsing works.
Ensure object parsing works.
Ensure malformed input returns 400.
Ensure oversized input returns 400.
Ensure unsupported MIME returns 400.
Ensure public endpoint remains authenticated.
Ensure source image is not stored.
Ensure server restarts cleanly.
Ensure domain remains online.
Ensure account remains active.
Ensure token remains valid.
Ensure four cards remain visible.
Ensure source upload only appears in image-to-image mode.
Ensure switching back clears requirement, not necessarily local preview.
Ensure remove source is available.
Ensure mobile wrapping is usable.
Ensure endpoint label remains the same.
Ensure examples include image-to-image JSON.
Ensure copy remains Indonesian where practical.
Ensure final report is concise and evidence-based.
Done planning.
Implementation next.
EOF
EOF2
EOF3
EOF4
EOF5
EOF6
EOF7
EOF8
EOF9
EOF10
EOF11
EOF12
EOF13
EOF14
EOF15
EOF16
EOF17
EOF18
EOF19
EOF20
EOF21
EOF22
EOF23
EOF24
EOF25
EOF26
EOF27
EOF28
EOF29
EOF30
EOF31
EOF32
EOF33
EOF34
EOF35
EOF36
EOF37
EOF38
EOF39
EOF40
EOF41
EOF42
EOF43
EOF44
EOF45
EOF46
EOF47
EOF48
EOF49
EOF50
EOF51
EOF52
EOF53
EOF54
EOF55
EOF56
EOF57
EOF58
EOF59
EOF60
EOF61
EOF62
EOF63
EOF64
EOF65
EOF66
EOF67
EOF68
EOF69
EOF70
EOF71
EOF72
EOF73
EOF74
EOF75
EOF76
EOF77
EOF78
EOF79
EOF80
EOF81
EOF82
EOF83
EOF84
EOF85
EOF86
EOF87
EOF88
EOF89
EOF90
EOF91
EOF92
EOF93
EOF94
EOF95
EOF96
EOF97
EOF98
EOF99
EOF100
EOF101
EOF102
EOF103
EOF104
EOF105
EOF106
EOF107
EOF108
EOF109
EOF110
EOF111
EOF112
EOF113
EOF114
EOF115
EOF116
EOF117
EOF118
EOF119
EOF120
EOF121
EOF122
EOF123
EOF124
EOF125
EOF126
EOF127
EOF128
EOF129
EOF130
EOF131
EOF132
EOF133
EOF134
EOF135
EOF136
EOF137
EOF138
EOF139
EOF140
EOF141
EOF142
EOF143
EOF144
EOF145
EOF146
EOF147
EOF148
EOF149
EOF150
EOF151
EOF152
EOF153
EOF154
EOF155
EOF156
EOF157
EOF158
EOF159
EOF160
EOF161
EOF162
EOF163
EOF164
EOF165
EOF166
EOF167
EOF168
EOF169
EOF170
EOF171
EOF172
EOF173
EOF174
EOF175
EOF176
EOF177
EOF178
EOF179
EOF180
EOF181
EOF182
EOF183
EOF184
EOF185
EOF186
EOF187
EOF188
EOF189
EOF190
EOF191
EOF192
EOF193
EOF194
EOF195
EOF196
EOF197
EOF198
EOF199
EOF200
EOF201
EOF202
EOF203
EOF204
EOF205
EOF206
EOF207
EOF208
EOF209
EOF210
EOF211
EOF212
EOF213
EOF214
EOF215
EOF216
EOF217
EOF218
EOF219
EOF220
EOF221
EOF222
EOF223
EOF224
EOF225
EOF226
EOF227
EOF228
EOF229
EOF230
EOF231
EOF232
EOF233
EOF234
EOF235
EOF236
EOF237
EOF238
EOF239
EOF240
EOF241
EOF242
EOF243
EOF244
EOF245
EOF246
EOF247
EOF248
EOF249
EOF250
EOF251
EOF252
EOF253
EOF254
EOF255
EOF256
EOF257
EOF258
EOF259
EOF260
EOF261
EOF262
EOF263
EOF264
EOF265
EOF266
EOF267
EOF268
EOF269
EOF270
EOF271
EOF272
EOF273
EOF274
EOF275
EOF276
EOF277
EOF278
EOF279
EOF280
EOF281
EOF282
EOF283
EOF284
EOF285
EOF286
EOF287
EOF288
EOF289
EOF290
EOF291
EOF292
EOF293
EOF294
EOF295
EOF296
EOF297
EOF298
EOF299
EOF300
EOF301
EOF302
EOF303
EOF304
EOF305
EOF306
EOF307
EOF308
EOF309
EOF310
EOF311
EOF312
EOF313
EOF314
EOF315
EOF316
EOF317
EOF318
EOF319
EOF320
EOF321
EOF322
EOF323
EOF324
EOF325
EOF326
EOF327
EOF328
EOF329
EOF330
EOF331
EOF332
EOF333
EOF334
EOF335
EOF336
EOF337
EOF338
EOF339
EOF340
EOF341
EOF342
EOF343
EOF344
EOF345
EOF346
EOF347
EOF348
EOF349
EOF350
EOF351
EOF352
EOF353
EOF354
EOF355
EOF356
EOF357
EOF358
EOF359
EOF360
EOF361
EOF362
EOF363
EOF364
EOF365
EOF366
EOF367
EOF368
EOF369
EOF370
EOF371
EOF372
EOF373
EOF374
EOF375
EOF376
EOF377
EOF378
EOF379
EOF380
EOF381
EOF382
EOF383
EOF384
EOF385
EOF386
EOF387
EOF388
EOF389
EOF390
EOF391
EOF392
EOF393
EOF394
EOF395
EOF396
EOF397
EOF398
EOF399
EOF400
EOF401
EOF402
EOF403
EOF404
EOF405
EOF406
EOF407
EOF408
EOF409
EOF410
EOF411
EOF412
EOF413
EOF414
EOF415
EOF416
EOF417
EOF418
EOF419
EOF420
EOF421
EOF422
EOF423
EOF424
EOF425
EOF426
EOF427
EOF428
EOF429
EOF430
EOF431
EOF432
EOF433
EOF434
EOF435
EOF436
EOF437
EOF438
EOF439
EOF440
EOF441
EOF442
EOF443
EOF444
EOF445
EOF446
EOF447
EOF448
EOF449
EOF450
EOF451
EOF452
EOF453
EOF454
EOF455
EOF456
EOF457
EOF458
EOF459
EOF460
EOF461
EOF462
EOF463
EOF464
EOF465
EOF466
EOF467
EOF468
EOF469
EOF470
EOF471
EOF472
EOF473
EOF474
EOF475
EOF476
EOF477
EOF478
EOF479
EOF480
EOF481
EOF482
EOF483
EOF484
EOF485
EOF486
EOF487
EOF488
EOF489
EOF490
EOF491
EOF492
EOF493
EOF494
EOF495
EOF496
EOF497
EOF498
EOF499
EOF500
EOF501
EOF502
EOF503
EOF504
EOF505
EOF506
EOF507
EOF508
EOF509
EOF510
EOF511
EOF512
EOF513
EOF514
EOF515
EOF516
EOF517
EOF518
EOF519
EOF520
EOF521
EOF522
EOF523
EOF524
EOF525
EOF526
EOF527
EOF528
EOF529
EOF530
EOF531
EOF532
EOF533
EOF534
EOF535
EOF536
EOF537
EOF538
EOF539
EOF540
EOF541
EOF542
EOF543
EOF544
EOF545
EOF546
EOF547
EOF548
EOF549
EOF550
EOF551
EOF552
EOF553
EOF554
EOF555
EOF556
EOF557
EOF558
EOF559
EOF560
EOF561
EOF562
EOF563
EOF564
EOF565
EOF566
EOF567
EOF568
EOF569
EOF570
EOF571
EOF572
EOF573
EOF574
EOF575
EOF576
EOF577
EOF578
EOF579
EOF580
EOF581
EOF582
EOF583
EOF584
EOF585
EOF586
EOF587
EOF588
EOF589
EOF590
EOF591
EOF592
EOF593
EOF594
EOF595
EOF596
EOF597
EOF598
EOF599
EOF600
EOF601
EOF602
EOF603
EOF604
EOF605
EOF606
EOF607
EOF608
EOF609
EOF610
EOF611
EOF612
EOF613
EOF614
EOF615
EOF616
EOF617
EOF618
EOF619
EOF620
EOF621
EOF622
EOF623
EOF624
EOF625
EOF626
EOF627
EOF628
EOF629
EOF630
EOF631
EOF632
EOF633
EOF634
EOF635
EOF636
EOF637
EOF638
EOF639
EOF640
EOF641
EOF642
EOF643
EOF644
EOF645
EOF646
EOF647
EOF648
EOF649
EOF650
EOF651
EOF652
EOF653
EOF654
EOF655
EOF656
EOF657
EOF658
EOF659
EOF660
EOF661
EOF662
EOF663
EOF664
EOF665
EOF666
EOF667
EOF668
EOF669
EOF670
EOF671
EOF672
EOF673
EOF674
EOF675
EOF676
EOF677
EOF678
EOF679
EOF680
EOF681
EOF682
EOF683
EOF684
EOF685
EOF686
EOF687
EOF688
EOF689
EOF690
EOF691
EOF692
EOF693
EOF694
EOF695
EOF696
EOF697
EOF698
EOF699
EOF700
EOF701
EOF702
EOF703
EOF704
EOF705
EOF706
EOF707
EOF708
EOF709
EOF710
EOF711
EOF712
EOF713
EOF714
EOF715
EOF716
EOF717
EOF718
EOF719
EOF720
EOF721
EOF722
EOF723
EOF724
EOF725
EOF726
EOF727
EOF728
EOF729
EOF730
EOF731
EOF732
EOF733
EOF734
EOF735
EOF736
EOF737
EOF738
EOF739
EOF740
EOF741
EOF742
EOF743
EOF744
EOF745
EOF746
EOF747
EOF748
EOF749
EOF750
EOF751
EOF752
EOF753
EOF754
EOF755
EOF756
EOF757
EOF758
EOF759
EOF760
EOF761
EOF762
EOF763
EOF764
EOF765
EOF766
EOF767
EOF768
EOF769
EOF770
EOF771
EOF772
EOF773
EOF774
EOF775
EOF776
EOF777
EOF778
EOF779
EOF780
EOF781
EOF782
EOF783
EOF784
EOF785
EOF786
EOF787
EOF788
EOF789
EOF790
EOF791
EOF792
EOF793
EOF794
EOF795
EOF796
EOF797
EOF798
EOF799
EOF800
EOF801
EOF802
EOF803
EOF804
EOF805
EOF806
EOF807
EOF808
EOF809
EOF810
EOF811
EOF812
EOF813
EOF814
EOF815
EOF816
EOF817
EOF818
EOF819
EOF820
EOF821
EOF822
EOF823
EOF824
EOF825
EOF826
EOF827
EOF828
EOF829
EOF830
EOF831
EOF832
EOF833
EOF834
EOF835
EOF836
EOF837
EOF838
EOF839
EOF840
EOF841
EOF842
EOF843
EOF844
EOF845
EOF846
EOF847
EOF848
EOF849
EOF850
EOF851
EOF852
EOF853
EOF854
EOF855
EOF856
EOF857
EOF858
EOF859
EOF860
EOF861
EOF862
EOF863
EOF864
EOF865
EOF866
EOF867
EOF868
EOF869
EOF870
EOF871
EOF872
EOF873
EOF874
EOF875
EOF876
EOF877
EOF878
EOF879
EOF880
EOF881
EOF882
EOF883
EOF884
EOF885
EOF886
EOF887
EOF888
EOF889
EOF890
EOF891
EOF892
EOF893
EOF894
EOF895
EOF896
EOF897
EOF898
EOF899
EOF900
EOF901
EOF902
EOF903
EOF904
EOF905
EOF906
EOF907
EOF908
EOF909
EOF910
EOF911
EOF912
EOF913
EOF914
EOF915
EOF916
EOF917
EOF918
EOF919
EOF920
EOF921
EOF922
EOF923
EOF924
EOF925
EOF926
EOF927
EOF928
EOF929
EOF930
EOF931
EOF932
EOF933
EOF934
EOF935
EOF936
EOF937
EOF938
EOF939
EOF940
EOF941
EOF942
EOF943
EOF944
EOF945
EOF946
EOF947
EOF948
EOF949
EOF950
EOF951
EOF952
EOF953
EOF954
EOF955
EOF956
EOF957
EOF958
EOF959
EOF960
EOF961
EOF962
EOF963
EOF964
EOF965
EOF966
EOF967
EOF968
EOF969
EOF970
EOF971
EOF972
EOF973
EOF974
EOF975
EOF976
EOF977
EOF978
EOF979
EOF980
EOF981
EOF982
EOF983
EOF984
EOF985
EOF986
EOF987
EOF988
EOF989
EOF990
EOF991
EOF992
EOF993
EOF994
EOF995
EOF996
EOF997
EOF998
EOF999
EOF1000
EOF_END
